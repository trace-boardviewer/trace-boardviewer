import { useMemo, useSyncExternalStore } from 'react';
import type { DocumentOverlay, DocumentRuntime, Notice, WorkspaceActions, WorkspaceApi, WorkspaceState } from './api';
import { createStatusStore } from './statusStore';
import type { ViewerCamera, ViewerProbeRegion } from '../components/viewer-contracts';
import {
  boardComponentsByRef, buildSchematicIndex, linkBoardSchematic, mapBoardNetToSchematic, mapBoardSelectionToSchematic, mapSchematicNetToBoard, mapSchematicSelectionToBoard, resolvePdfRefHits, searchAll,
} from '../lib/crossprobe';
import type { BoardIndex, DocumentSearchSource, Mapping, PdfLinkReport, SchematicIndex, SchematicTarget, SearchRow } from '../lib/crossprobe';
import type { DocumentRecord, WorkspaceAliases, WorkspaceManifest } from '../lib/documents';
import { boardIndexOf } from '../lib/board-index';
import { buildPdfFixture } from '../lib/pdf/pdf-fixture';
import type { PdfSession } from '../lib/pdf/session-contract';
import { bundledOcrEngine } from '../lib/ocr/bundled';
import { createPdfSession } from '../lib/pdf/session';
import type { Hit } from '../lib/pdf/search';
import { computeConnectivity } from '../lib/schematic/connectivity';
import { pinKey, symbolKey } from '../lib/schematic/model';
import type { SchSheetInstance, SchematicDesign } from '../lib/schematic/model';
import { SheetBuilder, buildSchematic } from '../lib/schematic/testing';
import type { Board, BoardComponent, BoardNote, BoardPin, BoardSide } from '../lib/types';
import { noteKeyIndex } from '../lib/note-keys';
import { removeNote as dropNote, upsertNote as applyNote } from '../lib/workspace';

/**
 * Complete mock of the application core for the UI harness and QA scripts: ORIGINAL SYNTHETIC data (a board with a
 * case-distinct ref pair, a pad on the far side of its parent, an ambiguous schematic ref, linked and disagreeing nets,
 * a PDF with duplicate and unique reference hits, missing/changed documents, notes) computed by the real cross-probe
 * library. Every action is recorded in `calls` so scripts can assert what the UI asked for.
 */
export interface MockOptions {
  persistence?: 'native' | 'session-only'; documents?: boolean; notesBlocked?: boolean; empty?: boolean; slowNotes?: number;
  /** Cameras and aliases survive a page reload (localStorage, keyed by `boardKey`): stands in for the native workspace manifest. */
  persistWorkspace?: boolean;
  /** Identity of the mock board; another key never sees the stored camera/aliases of the first (a different board). */
  boardKey?: string;
  /** The stored camera becomes readable only after this many ms, like the real core whose manifest loads after the board. */
  cameraDelay?: number;
}
export interface MockCall { name: string; args: unknown[] }
export interface MockWorkspace {
  getSnapshot(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  actions: WorkspaceActions;
  sheetsOf(documentId: string): SchSheetInstance[];
  statusStore: WorkspaceApi['statusStore'];
  calls: MockCall[];
  /** Test hooks. */
  hooks: {
    patch(patch: Partial<WorkspaceState>): void;
    failNextNote(): void;
    setKeyRequest(request: WorkspaceState['import']['keyRequest']): void;
    notify(kind: Notice['kind'], text: string): void;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------- board
type PinSpec = [number: string, name: string, net: string, side?: BoardSide];
const rectOutline = (cx: number, cy: number, hw: number, hh: number) => [{ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh }, { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh }];

function makeBoard(): Board {
  const components: BoardComponent[] = [];
  const pins: BoardPin[] = [];
  const add = (ref: string, value: string, pkg: string, side: BoardSide, cx: number, cy: number, specs: PinSpec[]) => {
    const id = `c:${ref}`;
    const pinIds: string[] = [];
    const rows = Math.ceil(specs.length / 2);
    specs.forEach(([number, name, net, pinSide], i) => {
      const pid = `${id}.${number}`;
      pinIds.push(pid);
      pins.push({ id: pid, componentId: id, number, name, net, side: pinSide ?? side, radius: 0.32, shape: 'round', x: cx + (i % 2 === 0 ? -1.3 : 1.3), y: cy + (Math.floor(i / 2) - (rows - 1) / 2) * 1.15 });
    });
    const hh = Math.max(1.1, rows * 0.7 + 0.5);
    components.push({ id, ref, value, package: pkg, side, position: { x: cx, y: cy }, rotation: 0, pinIds, bounds: { minX: cx - 2, minY: cy - hh, maxX: cx + 2, maxY: cy + hh }, outline: rectOutline(cx, cy, 2, hh) });
  };
  add('U1', 'TPS62130', 'QFN-8', 'top', 30, 40, [['1', 'VIN', '+3V3'], ['2', 'GND', 'GND'], ['3', 'SDA', 'SDA'], ['4', 'SCL', 'SCL'], ['5', 'NC', 'NC1']]);
  add('U7', 'LDO-1V8', 'SOT-23-6', 'top', 60, 40, [['1', 'IN', '+3V3'], ['2', 'GND', 'GND'], ['3', 'OUT', 'VCC_CORE'], ['4', 'EN', '+3V3']]);
  add('PU301', 'PMIC', 'BGA-8', 'top', 90, 40, [['1', 'A1', '+3V3'], ['2', 'A2', 'GND'], ['3', 'B1', 'VCC_CORE'], ['4', 'B2', 'SDA']]);
  add('R1', '10k', '0402', 'top', 30, 70, [['1', '', '+3V3'], ['2', '', 'SDA']]);
  add('r1', '100k', '0402', 'bottom', 30, 70, [['1', '', '+3V3'], ['2', '', 'NET_BOT']]);
  add('R2', '10k', '0402', 'top', 45, 70, [['1', '', '+3V3'], ['2', '', 'SCL']]);
  add('C1', '100n', '0402', 'top', 60, 70, [['1', '', '+3V3'], ['2', '', 'GND']]);
  add('C2', '1u', '0402', 'top', 75, 70, [['1', '', 'VCC_CORE'], ['2', '', 'GND']]);
  add('Q1', 'BSS138', 'SOT-23', 'top', 90, 70, [['1', 'G', 'SDA'], ['2', 'S', 'GND'], ['3', 'D', 'SCL', 'bottom']]);
  add('J1', 'HDR-6', 'HDR-1x6', 'both', 110, 70, [['1', 'VCC', '+3V3'], ['2', 'GND', 'GND'], ['3', 'SDA', 'SDA'], ['4', 'SCL', 'SCL'], ['5', 'IO1', 'NET_A'], ['6', 'IO2', 'NET_B']]);
  add('TP_VCORE_CPU', 'TP', 'TP-1', 'top', 110, 30, [['1', '', 'VCC_CORE']]);
  add('D1', '1N4148', 'SOD-123', 'top', 120, 50, [['1', 'A', 'NET_A'], ['2', 'K', '+3V3']]);
  const nets = ['+3V3', 'GND', 'SDA', 'SCL', 'VCC_CORE', 'NET_A', 'NET_B', 'NET_BOT'];
  for (let i = 3; i <= 40; i++) {
    const col = i % 10, row = Math.floor(i / 10);
    const side: BoardSide = i % 7 === 0 ? 'bottom' : 'top';
    add(`R${i}`, `${i}k`, '0402', side, 15 + col * 12, 95 + row * 9, [['1', '', nets[i % nets.length]], ['2', '', nets[(i + 3) % nets.length]]]);
    add(`C${i}`, `${i}n`, '0402', side, 15 + col * 12, 100 + row * 9 + 18, [['1', '', nets[(i + 1) % nets.length]], ['2', '', 'GND']]);
  }
  const byNet = new Map<string, string[]>();
  for (const pin of pins) if (pin.net) byNet.set(pin.net, [...(byNet.get(pin.net) ?? []), pin.id]);
  return {
    name: 'Mock phone mainboard', format: 'KiCad PCB', units: 'mm', components, pins, nets: [...byNet].map(([name, pinIds], i) => ({ id: `n${i}`, name, pinIds })),
    outline: rectOutline(75, 85, 80, 60), bounds: { minX: -5, minY: 25, maxX: 155, maxY: 145 }, warnings: [{ key: 'parse.warning.unsupportedRecords', params: { count: 2 } }],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------- schematic
function makeDesign(): SchematicDesign {
  const root = new SheetBuilder('root', 'power');
  const tie = (x: number, y: number, net: string) => {
    root.wire(x - 10, y, x, y);
    if (net === 'GND' || net === '+3V3' || net === 'VCC_CORE' || net === '+1V8') root.power(net, x - 10, y); else root.global(net, x - 10, y);
  };
  const part = (ref: string, x0: number, y0: number, nets: string[], options: { id?: string; value?: string } = {}) => {
    root.part(ref, nets.map((net, i) => ({ n: String(i + 1), x: x0, y: y0 + i * 10 })), { ...options });
    nets.forEach((net, i) => tie(x0, y0 + i * 10, net));
  };
  part('U1', 40, 30, ['+3V3', 'GND', 'SDA', 'SCL'], { value: 'TPS62130' });
  part('R1', 80, 30, ['+3V3', 'SDA'], { value: '10k' });
  part('R2', 110, 30, ['+3V3', 'SCL'], { value: '10k' });
  part('C1', 140, 30, ['+3V3', 'GND'], { value: '100n' });
  part('C2', 170, 30, ['+1V8', 'GND'], { value: '1u' });
  part('U7', 40, 90, ['+3V3', 'GND', 'VCC_CORE'], { id: 'U7a', value: 'LDO-1V8' });
  part('U7', 90, 90, ['+3V3', 'GND', 'VCC_CORE'], { id: 'U7b', value: 'LDO-1V8' });
  part('PU301', 140, 90, ['+3V3', 'GND', 'VCC_CORE', 'SDA'], { value: 'PMIC' });
  part('R99', 180, 90, ['SDA', 'GND'], { value: '47k' });
  part('q1', 140, 60, ['SDA', 'GND'], { value: 'BSS138' }); // lower-case twin of the board's Q1: flagged, never linked
  root.sheet('sub1', 'sub', 'Regulator', [{ name: 'VIN', x: 210, y: 30 }], { at: { x: 200, y: 20 }, size: { x: 30, y: 20 } });
  root.sheet('gone', null, 'Amplifier', [], { file: 'amp.kicad_sch', defId: null, at: { x: 200, y: 60 }, size: { x: 30, y: 20 } });
  // NET_A is a LOCAL net on two sheets: the board net of that name resolves to two schematic nets (an explicit choice, never a guess).
  root.wire(230, 100, 240, 100).local('NET_A', 230, 100);
  const sub = new SheetBuilder('sub', 'sub').hier('VIN', 0, 0).wire(0, 0, 10, 0).part('R30', [{ n: '1', x: 10, y: 0 }, { n: '2', x: 10, y: 10 }]).global('GND', 10, 10).wire(30, 0, 40, 0).local('NET_A', 30, 0);
  const schematic = buildSchematic([root, sub], { name: 'power' });
  schematic.formatLabel = 'KiCad schematic (version 20231120)';
  schematic.diagnostics.push({ severity: 'warning', code: 'SHEET_FILE_MISSING', message: 'The sheet file "amp.kicad_sch" was not found next to the schematic.' });
  return { schematic, connectivity: computeConnectivity(schematic) };
}

// ---------------------------------------------------------------------------------------------------------------------------- documents
const hex = (seed: string) => (seed.repeat(64)).slice(0, 64);
const record = (id: string, kind: DocumentRecord['kind'], name: string, extra: Partial<DocumentRecord> = {}): DocumentRecord =>
  ({ id, kind, name, path: `C:/service/${name}`, key: hex(id.replace(/[^0-9a-f]/g, 'a') || 'a'), size: 120_000, bookmarks: [], annotations: [], addedAt: '2026-10-05T10:00:00.000Z', ...extra });

const pdfPage = (n: number, texts: Array<[number, number, string]>) => ({ texts: [{ x: 72, y: 730, text: `Service manual page ${n}`, size: 18 }, ...texts.map(([x, y, text]) => ({ x, y, text })) ] });
function makePdf(id: string): PdfSession {
  const data = buildPdfFixture({
    pages: [pdfPage(1, [[72, 680, 'U1'], [140, 680, 'R1'], [200, 680, 'R2'], [72, 640, 'Block diagram: +3V3 rail feeds U1 and PU301']]),
      pdfPage(2, [[72, 680, 'PU301'], [200, 560, 'PU301'], [72, 640, 'VCC_CORE'], [140, 640, 'TP_VCORE_CPU'], [72, 600, 'U7 powers the core rail']]),
      pdfPage(3, [[72, 680, 'J1'], [140, 680, 'Q1'], [72, 640, 'SDA SCL pull-ups R1 R2']])],
    outline: [{ title: 'Block diagram', page: 1 }, { title: 'Power', page: 2, children: [{ title: 'Core rail', page: 2 }] }, { title: 'Connectors', page: 3 }],
  });
  return createPdfSession({ id, data, ocr: { engine: bundledOcrEngine } });
}
async function makePng(): Promise<Uint8Array> {
  const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 420 });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1d5a3c'; ctx.fillRect(0, 0, 640, 420);
  ctx.fillStyle = '#2b2b2f'; for (let i = 0; i < 12; i++) ctx.fillRect(40 + (i % 4) * 140, 40 + Math.floor(i / 4) * 120, 90, 70);
  ctx.fillStyle = '#e8eff5'; ctx.font = '600 16px sans-serif'; ctx.fillText('U1', 70, 80);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob!.arrayBuffer());
}

const now = () => new Date().toISOString();
const NO_CAMERA: ViewerCamera = Object.freeze({});

export function createMockWorkspace(options: MockOptions = {}): MockWorkspace {
  const board = makeBoard();
  const boardIndex: BoardIndex = boardIndexOf(board);
  const statusStore = createStatusStore();
  statusStore.setSource('KiCad PCB · mm · real geometry');
  const calls: MockCall[] = [];
  const listeners = new Set<() => void>();
  const boardKey = options.boardKey ?? 'a'.repeat(64);
  const storageKey = `trace-mock-workspace:${boardKey}`;
  const stored = (() => { try { return options.persistWorkspace ? JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { cameras?: Record<string, ViewerCamera>; aliases?: WorkspaceAliases } | null : null; } catch { return null; } })();
  const cameras = new Map<string, ViewerCamera>(Object.entries(stored?.cameras ?? {}));
  let aliases: WorkspaceAliases = { refs: { ...(stored?.aliases?.refs ?? {}) }, nets: { ...(stored?.aliases?.nets ?? {}) } };
  let cameraReady = !options.cameraDelay;
  const persist = () => { if (!options.persistWorkspace) return; try { localStorage.setItem(storageKey, JSON.stringify({ cameras: Object.fromEntries(cameras), aliases })); } catch { /* private window */ } };
  const sessions = new Map<string, PdfSession>();
  let noticeId = 0, failNote = false, searchToken = 0;
  let schIndex: SchematicIndex | null = null;

  const docs: DocumentRuntime[] = [];
  if (options.documents !== false && !options.empty) {
    const design = makeDesign();
    docs.push({ record: record('sch1', 'schematic', 'power.kicad_sch', { size: 48_000 }), status: 'ready', design, designState: 'ready' });
    sessions.set('pdf1', makePdf('pdf1'));
    docs.push({ record: record('pdf1', 'pdf', 'service-manual.pdf', { pageCount: 3, bookmarks: [{ id: 'b1', page: 2, label: 'Power tree' }, { id: 'b2', page: 3, label: 'Connector pinout' }] }), status: 'ready', pdf: sessions.get('pdf1') });
    docs.push({ record: record('img1', 'image', 'board-photo.png', { size: 380_000 }), status: 'loading' });
    docs.push({ record: record('miss1', 'pdf', 'old-datasheet.pdf', { missing: true }), status: 'missing', message: 'C:/service/old-datasheet.pdf was not found. Notes and bookmarks are kept; relink the same file to continue.' });
    docs.push({ record: record('chg1', 'pdf', 'changed-notes.pdf'), status: 'changed', message: 'The file changed on disk since it was attached.' });
  }
  const notes: BoardNote[] = options.empty ? [] : [
    { id: 'n1', target: { ref: 'U1' }, text: 'Replaced after short on VIN. Check the inductor next.', measurements: { voltage: '3.28 V', resistance: '4.7 kΩ to GND' }, updatedAt: '2026-10-05T09:00:00.000Z' },
    { id: 'n2', target: { ref: 'U1', pin: '3' }, text: 'SDA idles low.', measurements: { voltage: '0.12 V' }, updatedAt: '2026-10-05T09:05:00.000Z' },
  ];
  const rootPath = (id: string) => docs.find(d => d.record.id === id)?.design?.schematic.instances[0]?.path ?? '';
  let state: WorkspaceState = {
    board: options.empty ? null : board, boardIndex: options.empty ? null : boardIndex, boardKey: options.empty ? null : boardKey, boardPath: 'C:/service/mainboard.kicad_pcb', manifest: null, activeTab: 'board',
    split: { enabled: false, ratio: 0.5, right: null }, documents: docs, notes, notesBlocked: options.notesBlocked ? { text: 'notes.json is unreadable (invalid JSON).' } : null,
    save: { dirty: false, saving: false, failure: null }, selection: { componentId: null, pinId: null, net: null },
    probe: { origin: null, nonce: 0, schematic: null, schematicMapping: null, boardMapping: null, documentRef: null, schematicNetMapping: null, boardNetMapping: null },
    search: { query: '', result: null, pending: false }, link: null, pdfLinks: {}, overlays: {}, notices: [], persistence: options.persistence ?? 'native',
    import: { phase: 'idle', keyRequest: null, recents: [{ name: 'mainboard.kicad_pcb', path: 'C:/service/mainboard.kicad_pcb', openedAt: '2026-10-04T08:00:00.000Z' }, { name: 'older.gc', path: 'C:/service/older.gc', openedAt: '2026-09-01T08:00:00.000Z' }], file: options.empty ? null : { name: 'mainboard.kicad_pcb', path: 'C:/service/mainboard.kicad_pcb', key: boardKey }, progress: null, reportContext: null },
  };
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const set = (patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>)) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; emit(); };
  const record_ = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  const notify = (kind: Notice['kind'], text: string) => set(s => ({ notices: [...s.notices, { id: ++noticeId, kind, message: { text } }] }));
  const updateDoc = (id: string, patch: Partial<DocumentRuntime> | ((d: DocumentRuntime) => Partial<DocumentRuntime>)) =>
    set(s => ({ documents: s.documents.map(d => d.record.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d) }));

  const readySchematics = () => state.documents.filter(d => d.record.kind === 'schematic' && d.status === 'ready' && d.design);
  const rebuildLink = () => {
    const ready = readySchematics();
    schIndex = ready.length ? buildSchematicIndex(ready.map(d => ({ documentId: d.record.id, design: d.design! }))) : null;
    set({ link: schIndex ? linkBoardSchematic(boardIndex, schIndex, aliases) : null });
  };

  // Native mode publishes a workspace manifest (the part the UI reads: aliases); session-only publishes none, like the real core.
  const manifestOf = (): WorkspaceManifest | null => options.empty || (options.persistence ?? 'native') !== 'native' ? null : {
    version: 1, board: { key: boardKey, name: 'mainboard.kicad_pcb', path: 'C:/service/mainboard.kicad_pcb', format: 'KiCad PCB' }, documents: [], split: { enabled: false, ratio: 0.5, right: null }, activeTab: 'board', cameras: {}, aliases, updatedAt: now(),
  };
  const aliasesChanged = () => {
    persist(); rebuildLink();
    set({ manifest: manifestOf() });
    const { selection } = state;
    if (selection.pinId) selectPin(selection.pinId, { origin: state.probe.origin ?? 'inspector' });
    else if (selection.componentId) selectComponent(selection.componentId, { origin: state.probe.origin ?? 'inspector' });
    else if (selection.net) actions.selectNet(selection.net, state.probe.origin);
  };

  // --- cross-probe -------------------------------------------------------------------------------------------------
  const probeFor = (origin: WorkspaceState['probe']['origin'], componentId: string | null, pinId: string | null, center: boolean): Partial<WorkspaceState> => {
    const nonce = state.probe.nonce + (center ? 1 : 0);
    const component = componentId ? boardIndex.componentById.get(componentId) : undefined;
    let mapping: Mapping<SchematicTarget> | null = null;
    let schematic: WorkspaceState['probe']['schematic'] = null;
    if (schIndex && componentId) {
      mapping = mapBoardSelectionToSchematic(boardIndex, schIndex, { componentId, ...(pinId ? { pinId } : {}) }, aliases);
      const target = mapping.status === 'unique' ? mapping.candidates[0] : null;
      if (target) schematic = schematicSelectionOf(target);
    }
    return { probe: { origin, nonce, schematic: schematic ?? state.probe.schematic, schematicMapping: mapping, boardMapping: null, documentRef: component?.ref ?? null, schematicNetMapping: null, boardNetMapping: null } };
  };
  const schematicSelectionOf = (target: SchematicTarget): NonNullable<WorkspaceState['probe']['schematic']> => {
    const unit = target.units[0], pin = target.pin?.placements[0];
    const instancePath = pin?.instancePath ?? unit?.instancePath ?? '';
    return { documentId: target.documentId, instancePath, selection: { ...(unit ? { symbolKey: symbolKey(unit.instancePath, unit.symbolId) } : {}), ...(pin ? { pinKey: pinKey(pin.instancePath, pin.symbolId, pin.pinId) } : {}), ...(target.pin?.netId ? { netId: target.pin.netId } : {}) } };
  };
  const selectComponent: WorkspaceActions['selectComponent'] = (id, opts) => {
    record_('selectComponent', id, opts);
    set({ selection: { componentId: id, pinId: null, net: null }, ...(id ? probeFor(opts?.origin ?? 'inspector', id, null, !!opts?.center) : { probe: { ...state.probe, schematicMapping: null, documentRef: null } }) });
  };
  const selectPin: WorkspaceActions['selectPin'] = (id, opts) => {
    record_('selectPin', id, opts);
    const pin = boardIndex.pinById.get(id); if (!pin) return;
    set({ selection: { componentId: pin.componentId, pinId: id, net: pin.net || null }, ...probeFor(opts?.origin ?? 'inspector', pin.componentId, id, !!opts?.center) });
  };

  // --- pdf cross-reference (computed once per ready session) ---------------------------------------------------------
  const indexPdf = async (documentId: string, session: PdfSession) => {
    set(s => ({ overlays: { ...s.overlays, [documentId]: { highlights: [], probeRegions: [], state: 'working' } } }));
    const refs = new Set(board.components.map(c => c.ref)), nets = new Set(board.nets.map(n => n.name));
    const scan = await session.refCandidates(refs, nets);
    const report: PdfLinkReport = resolvePdfRefHits(scan, boardIndex, { documentId });
    const regions: ViewerProbeRegion[] = [];
    for (const link of report.links) for (const hit of link.hits) regions.push({ id: `${link.kind}:${link.name}:${hit.page}:${hit.itemIndex}`, page: hit.page, rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height }, label: link.name });
    const overlay: DocumentOverlay = { highlights: [], probeRegions: regions, state: scan.truncated ? 'truncated' : 'ready' };
    set(s => ({ pdfLinks: { ...s.pdfLinks, [documentId]: report }, overlays: { ...s.overlays, [documentId]: overlay } }));
  };

  // --- search ----------------------------------------------------------------------------------------------------
  const runSearch = (query: string) => {
    const token = ++searchToken;
    if (!query.trim()) { set({ search: { query, result: null, pending: false } }); return; }
    const pdfs = state.documents.filter(d => d.record.kind === 'pdf' && d.status === 'ready' && d.pdf);
    const base = searchAll({ query, board: boardIndex, schematic: schIndex });
    set({ search: { query, result: base, pending: pdfs.length > 0 } });
    if (!pdfs.length) return;
    void Promise.all(pdfs.map(async (d): Promise<DocumentSearchSource> => ({ documentId: d.record.id, name: d.record.name, hits: await d.pdf!.find(query, { maxHits: 50 }).catch(() => [] as Hit[]) }))).then(sources => {
      if (token !== searchToken) return;
      set({ search: { query, result: searchAll({ query, board: boardIndex, schematic: schIndex, documents: sources }), pending: false } });
    });
  };

  const actions: WorkspaceActions = {
    openBoard: async () => { record_('openBoard'); },
    openRecent: async path => { record_('openRecent', path); },
    openDropped: async files => { record_('openDropped', files.map(f => f.name)); },
    submitKey: text => { record_('submitKey', text); set(s => ({ import: { ...s.import, keyRequest: null } })); },
    cancelKeyRequest: () => { record_('cancelKeyRequest'); set(s => ({ import: { ...s.import, keyRequest: null } })); },
    closeBoard: () => { record_('closeBoard'); set({ board: null, boardIndex: null, boardKey: null, import: { ...state.import, file: null } }); },
    cancelImport: () => { record_('cancelImport'); set(s => ({ import: { ...s.import, phase: 'idle', progress: null } })); },
    setActiveTab: tab => { record_('setActiveTab', tab); set({ activeTab: tab }); },
    setSplit: patch => {
      record_('setSplit', patch);
      set(s => ({ split: { enabled: patch.enabled ?? s.split.enabled, ratio: patch.ratio === undefined ? s.split.ratio : Math.min(0.8, Math.max(0.2, patch.ratio)), right: patch.right === undefined ? s.split.right : patch.right } }));
    },
    setCamera: (source, camera) => { record_('setCamera', source, camera); cameras.set(source, camera); persist(); },
    cameraOf: source => {
      if (source === 'board' && !cameraReady) return NO_CAMERA;
      let camera = cameras.get(source); if (!camera) { camera = {}; cameras.set(source, camera); } return camera;
    },
    attachDocuments: async kinds => { record_('attachDocuments', kinds); },
    attachFiles: async files => { record_('attachFiles', files.map(f => f.name)); notify('info', `Mock: ${files.length} file(s) received.`); },
    removeDocument: id => { record_('removeDocument', id); set(s => ({ documents: s.documents.filter(d => d.record.id !== id) })); rebuildLink(); },
    relinkDocument: async id => { record_('relinkDocument', id); },
    acceptChangedDocument: async id => { record_('acceptChangedDocument', id); updateDoc(id, d => ({ status: 'ready', message: undefined, pdf: d.pdf ?? (() => { const s = makePdf(id); sessions.set(id, s); return s; })() })); },
    setBookmarks: (id, next) => { record_('setBookmarks', id, next); updateDoc(id, d => ({ record: { ...d.record, bookmarks: next } })); },
    setAnnotations: (id, next) => { record_('setAnnotations', id, next); updateDoc(id, d => ({ record: { ...d.record, annotations: next } })); },
    setCalibration: (id, next) => { record_('setCalibration', id, next); updateDoc(id, d => ({ record: { ...d.record, calibration: next } })); },
    exportWorkspace: async o => { record_('exportWorkspace', o); return { path: 'C:/exports/bundle.zip', files: o.documentIds.length + (o.includeBoard ? 1 : 0) + (o.includeNotes ? 1 : 0), bytes: 1_500_000 }; },
    selectComponent, selectPin,
    selectNet: (name, origin) => {
      record_('selectNet', name, origin);
      // Clearing a net keeps the selected part; choosing one selects the net alone.
      const netMapping = name && schIndex ? mapBoardNetToSchematic(boardIndex, schIndex, name, aliases) : null;
      const unique = netMapping?.status === 'unique' ? netMapping.candidates[0] : null;
      set({ selection: name ? { componentId: null, pinId: null, net: name } : { ...state.selection, net: null },
        probe: { ...state.probe, origin: origin ?? 'inspector', ...(name ? { schematicMapping: null, documentRef: null, schematicNetMapping: netMapping, boardNetMapping: null } : { schematicNetMapping: null }),
          ...(unique ? { schematic: { documentId: unique.documentId, instancePath: unique.scopePath ?? rootPath(unique.documentId), selection: { netId: unique.netId } } } : {}) } });
    },
    selectSchematicSymbol: target => {
      record_('selectSchematicSymbol', target);
      const boardMapping = schIndex ? mapSchematicSelectionToBoard(boardIndex, schIndex, { documentId: target.documentId, instancePath: target.instancePath, symbolId: target.symbolId }, aliases) : null;
      set({ probe: { ...state.probe, origin: 'schematic', schematic: { documentId: target.documentId, instancePath: target.instancePath, selection: { symbolKey: symbolKey(target.instancePath, target.symbolId) } }, boardMapping } });
      if (boardMapping?.status === 'unique') selectComponent(boardMapping.candidates[0].componentId, { origin: 'schematic' });
    },
    selectSchematicPin: target => {
      record_('selectSchematicPin', target);
      const boardMapping = schIndex ? mapSchematicSelectionToBoard(boardIndex, schIndex, { documentId: target.documentId, instancePath: target.instancePath, symbolId: target.symbolId, pinId: target.pinId }, aliases) : null;
      set({ probe: { ...state.probe, origin: 'schematic', schematic: { documentId: target.documentId, instancePath: target.instancePath, selection: { symbolKey: symbolKey(target.instancePath, target.symbolId), pinKey: pinKey(target.instancePath, target.symbolId, target.pinId) } }, boardMapping } });
    },
    selectSchematicNet: (documentId, netId) => {
      record_('selectSchematicNet', documentId, netId);
      const boardNetMapping = netId && schIndex ? mapSchematicNetToBoard(boardIndex, schIndex, { documentId, netId }, aliases) : null;
      set({ probe: { ...state.probe, origin: 'schematic', boardNetMapping, schematicNetMapping: null, schematic: { documentId, instancePath: state.probe.schematic?.instancePath ?? rootPath(documentId), selection: netId ? { netId } : {} } } });
    },
    chooseSchematicNet: index => {
      record_('chooseSchematicNet', index);
      const mapping = state.probe.schematicNetMapping; const target = mapping?.candidates[index]; if (!mapping || !target) return;
      set({ probe: { ...state.probe, origin: 'inspector', nonce: state.probe.nonce + 1, schematic: { documentId: target.documentId, instancePath: target.scopePath ?? rootPath(target.documentId), selection: { netId: target.netId } }, schematicNetMapping: { ...mapping, status: 'unique', candidates: [target], total: 1, truncated: false, reasons: [] } } });
    },
    chooseBoardNet: index => {
      record_('chooseBoardNet', index);
      const mapping = state.probe.boardNetMapping; const target = mapping?.candidates[index]; if (!mapping || !target) return;
      set({ selection: { componentId: null, pinId: null, net: target.name }, probe: { ...state.probe, origin: 'schematic', nonce: state.probe.nonce + 1, boardNetMapping: { ...mapping, status: 'unique', candidates: [target], total: 1, truncated: false, reasons: [] } } });
    },
    chooseSchematicTarget: index => {
      record_('chooseSchematicTarget', index);
      const mapping = state.probe.schematicMapping; const target = mapping?.candidates[index]; if (!mapping || !target) return;
      set({ probe: { ...state.probe, origin: 'inspector', nonce: state.probe.nonce + 1, schematic: schematicSelectionOf(target), schematicMapping: { ...mapping, status: 'unique', candidates: [target], total: 1, truncated: false, reasons: [] } } });
    },
    chooseBoardTarget: index => {
      record_('chooseBoardTarget', index);
      const target = state.probe.boardMapping?.candidates[index]; if (target) selectComponent(target.componentId, { center: true, origin: 'schematic' });
    },
    activateProbeRegion: (documentId, regionId) => {
      record_('activateProbeRegion', documentId, regionId);
      const name = regionId.split(':')[1]; const target = boardComponentsByRef(boardIndex, name)[0]; if (target) selectComponent(target.id, { center: true, origin: 'document' });
    },
    setSchematicInstance: (documentId, instancePath) => { record_('setSchematicInstance', documentId, instancePath); set({ probe: { ...state.probe, schematic: { documentId, instancePath, selection: {} } } }); },
    clearSelection: () => { record_('clearSelection'); set({ selection: { componentId: null, pinId: null, net: null } }); },
    setAlias: (kind, from, to) => { record_('setAlias', kind, from, to); aliases = { ...aliases, [kind]: { ...aliases[kind], [from]: to } }; aliasesChanged(); },
    removeAlias: (kind, from) => { record_('removeAlias', kind, from); const next = { ...aliases[kind] }; delete next[from]; aliases = { ...aliases, [kind]: next }; aliasesChanged(); },
    setSearchQuery: query => { record_('setSearchQuery', query); runSearch(query); },
    activateSearchRow: (row: SearchRow) => {
      record_('activateSearchRow', row);
      switch (row.source) {
        case 'board-components': selectComponent(row.componentId, { center: true, origin: 'search' }); break;
        case 'board-nets': actions.selectNet(row.name, 'search'); break;
        case 'schematic-symbols': actions.selectSchematicSymbol({ documentId: row.documentId, instancePath: row.instancePath, symbolId: row.symbolId, ref: row.ref }); break;
        case 'schematic-nets': actions.selectSchematicNet(row.documentId, row.netId); break;
        case 'documents': cameras.set(row.documentId, { page: row.page, fit: 'width' }); set({ activeTab: state.split.enabled ? state.activeTab : 'documents', split: { ...state.split, right: { kind: 'document', id: row.documentId } } }); break;
      }
    },
    upsertNote: async (target, patch) => {
      record_('upsertNote', target, patch);
      if (options.slowNotes) await new Promise(resolve => setTimeout(resolve, options.slowNotes));
      if (state.notesBlocked) { notify('error', 'Notes are locked: nothing was written.'); return; }
      if (failNote) { failNote = false; notify('error', 'The note could not be saved (mock failure).'); return; }
      const keyed = noteKeyIndex(state.board ?? board).target(target.componentId, target.pinId);
      if (!keyed.ok) { notify('error', 'The note could not be saved: the part or pin cannot be told apart from another one.'); return; }
      const next = applyNote(state.notes, keyed.key, patch, now(), () => crypto.randomUUID());
      set({ notes: next });
    },
    removeNote: async id => { record_('removeNote', id); set({ notes: dropNote(state.notes, id) }); },
    retryNotes: async () => { record_('retryNotes'); set({ notesBlocked: null }); notify('success', 'Notes reloaded.'); },
    dismissNotice: id => { set(s => ({ notices: s.notices.filter(n => n.id !== id) })); },
  };

  // --- startup: rebuild the link, index PDFs, generate the photo ----------------------------------------------------------
  if (!cameraReady) setTimeout(() => { cameraReady = true; set({}); }, options.cameraDelay);
  rebuildLink();
  set({ manifest: manifestOf() });
  for (const d of docs) if (d.pdf && d.status === 'ready') void indexPdf(d.record.id, d.pdf);
  if (docs.some(d => d.record.id === 'img1')) void makePng().then(bytes => updateDoc('img1', { status: 'ready', bytes }));
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    actions, statusStore, calls,
    sheetsOf: id => state.documents.find(d => d.record.id === id)?.design?.schematic.instances ?? [],
    hooks: {
      patch: patch => set(patch), failNextNote: () => { failNote = true; },
      setKeyRequest: request => set(s => ({ import: { ...s.import, keyRequest: request } })), notify,
    },
  };
}

/** Binds a mock to React; the returned api changes identity only with the state (like the real hook). */
export function useMockWorkspace(mock: MockWorkspace): WorkspaceApi {
  const state = useSyncExternalStore(mock.subscribe, mock.getSnapshot, mock.getSnapshot);
  return useMemo(() => ({ state, actions: mock.actions, sheetsOf: mock.sheetsOf, statusStore: mock.statusStore }), [state, mock]);
}
