import type { ViewerHighlight, ViewerProbeRegion } from '../components/viewer-contracts';
import {
  mapBoardNetToSchematic, mapBoardSelectionToSchematic, mapSchematicNetToBoard, mapSchematicSelectionToBoard, normalizeKey,
} from '../lib/crossprobe';
import type {
  BoardIndex, BoardNetTarget, BoardTarget, Mapping, PdfLinkHit, PdfLinkReport, PdfRefLink, SchematicIndex, SchematicNetTarget, SchematicTarget,
} from '../lib/crossprobe';
import type { WorkspaceAliases } from '../lib/documents';
import { symbolKey } from '../lib/schematic/model';
import type { BoardSelectionState, DocumentOverlay, ProbeState } from './api';

/**
 * Pure selection / mapping / overlay logic of the cross-probe (no state, no I/O): the controller feeds it the indexes and
 * stores the results. Identity rules live in src/lib/crossprobe.ts; this layer only decides WHAT is shown for a result:
 * a unique mapping is followed, an ambiguous one is handed to the user, nothing is ever linked by guesswork.
 */
export const EMPTY_SELECTION: BoardSelectionState = Object.freeze({ componentId: null, pinId: null, net: null });
export const EMPTY_PROBE: ProbeState = Object.freeze({ origin: null, nonce: 0, schematic: null, schematicMapping: null, boardMapping: null, documentRef: null, schematicNetMapping: null, boardNetMapping: null });

export type SchematicView = NonNullable<ProbeState['schematic']>;
export interface ProbeInputs {
  board: BoardIndex | null;
  schematic: SchematicIndex | null;
  aliases: WorkspaceAliases | undefined;
  /** Sheet instance each schematic document currently shows: preferred when a part has several placements. */
  views: ReadonlyMap<string, string>;
}

const pick = <T extends { instancePath: string }>(list: readonly T[], prefer?: string): T | undefined => (prefer === undefined ? undefined : list.find(item => item.instancePath === prefer)) ?? list[0];

/** The schematic pane state for one unique/chosen target: the pin (with its net) when the target has one, else the symbol. */
export function viewOfTarget(target: SchematicTarget, preferInstance?: string): SchematicView | null {
  const pin = target.pin;
  if (pin && pin.placements.length) {
    const placement = pick(pin.placements, preferInstance)!;
    return { documentId: target.documentId, instancePath: placement.instancePath, selection: { symbolKey: symbolKey(placement.instancePath, placement.symbolId), pinKey: placement.pinKey, ...(pin.netId ? { netId: pin.netId } : {}) } };
  }
  const unit = pick(target.units, preferInstance);
  return unit ? { documentId: target.documentId, instancePath: unit.instancePath, selection: { symbolKey: symbolKey(unit.instancePath, unit.symbolId) } } : null;
}

/** The schematic pane state for one schematic net: its own sheet instance for a local/hierarchical net, else the sheet being looked at. */
export function viewOfNetTarget(schematic: SchematicIndex, net: SchematicNetTarget, preferInstance?: string): SchematicView | null {
  const sheets = [...schematic.sheets.values()].filter(sheet => sheet.documentId === net.documentId);
  const instancePath = net.scopePath !== undefined && sheets.some(sheet => sheet.instancePath === net.scopePath) ? net.scopePath : preferInstance ?? sheets[0]?.instancePath;
  return instancePath === undefined ? null : { documentId: net.documentId, instancePath, selection: { netId: net.netId } };
}

export interface ForwardResult {
  /** Null without a schematic or without a selected part; a `missing` mapping is kept so the UI can explain why nothing links. */
  mapping: Mapping<SchematicTarget> | null;
  /** Net-only selection: the schematic nets with that name (any status is kept: `ambiguous` = explicit choice, `missing` = explanation). Null otherwise. */
  netMapping: Mapping<SchematicNetTarget> | null;
  /** The target to show when the mapping is unique (net-only selections included); null for ambiguous / missing. */
  view: SchematicView | null;
}
const NO_FORWARD: ForwardResult = Object.freeze({ mapping: null, netMapping: null, view: null });

/** Board selection → schematic: pin if a pad is selected, else the part, else (net-only) the schematic net with the same name. */
export function mapBoardToSchematic(inputs: ProbeInputs, selection: BoardSelectionState): ForwardResult {
  const { board, schematic, aliases, views } = inputs;
  if (!board || !schematic || schematic.documents.length === 0) return NO_FORWARD;
  if (selection.componentId) {
    const mapping = mapBoardSelectionToSchematic(board, schematic, selection.pinId ? { componentId: selection.componentId, pinId: selection.pinId } : { componentId: selection.componentId }, aliases);
    if (mapping.status !== 'unique') return { mapping, netMapping: null, view: null };
    const target = mapping.candidates[0];
    return { mapping, netMapping: null, view: viewOfTarget(target, views.get(target.documentId)) };
  }
  if (selection.net) {
    const netMapping = mapBoardNetToSchematic(board, schematic, selection.net, aliases);
    if (netMapping.status !== 'unique') return { mapping: null, netMapping, view: null };
    return { mapping: null, netMapping, view: viewOfNetTarget(schematic, netMapping.candidates[0], views.get(netMapping.candidates[0].documentId)) };
  }
  return NO_FORWARD;
}

export interface SchematicPick { documentId: string; instancePath: string; symbolId: string; pinId?: string }
/** Schematic symbol / pin → board component and pad(s). */
export function mapSchematicToBoard(inputs: ProbeInputs, target: SchematicPick): Mapping<BoardTarget> | null {
  if (!inputs.board || !inputs.schematic) return null;
  return mapSchematicSelectionToBoard(inputs.board, inputs.schematic, target, inputs.aliases);
}
/** Schematic net → board nets (a unique match is followed, several are an explicit choice, none is explained). */
export function mapSchematicNet(inputs: ProbeInputs, documentId: string, netId: string): Mapping<BoardNetTarget> | null {
  if (!inputs.board || !inputs.schematic) return null;
  return mapSchematicNetToBoard(inputs.board, inputs.schematic, { documentId, netId }, inputs.aliases);
}

/** Board selection a chosen/unique board target stands for. The first pad of a split-pad pin is selected; its net is the pin's single net. */
export const selectionOfBoardTarget = (target: BoardTarget): BoardSelectionState => ({ componentId: target.componentId, pinId: target.pin?.pinIds[0] ?? null, net: target.pin?.net || null });

/** The exact reference the document panes should look for: the selected part's reference, else the selected net's name. */
export function documentRefOf(board: BoardIndex | null, selection: BoardSelectionState): string | null {
  if (selection.componentId) {
    const ref = board?.componentById.get(selection.componentId)?.ref;
    if (ref && normalizeKey(ref)) return ref;
  }
  return selection.net && normalizeKey(selection.net) ? selection.net : null;
}

/** The single board component whose reference literally equals `text` (after NFKC/trim); null for none or duplicates. */
export function uniqueComponentByRef(board: BoardIndex | null, text: string): string | null {
  const list = board?.byRef.get(normalizeKey(text));
  return list && list.length === 1 ? list[0].id : null;
}

export const sameSchematicSelection = (a: SchematicView['selection'], b: SchematicView['selection']) => a.symbolKey === b.symbolKey && a.pinKey === b.pinKey && a.netId === b.netId;
export const sameView = (a: SchematicView | null, b: SchematicView | null) => a === b || (a !== null && b !== null && a.documentId === b.documentId && a.instancePath === b.instancePath && sameSchematicSelection(a.selection, b.selection));

// ---------------------------------------------------------------------------------------------------------------
// PDF cross-reference
// ---------------------------------------------------------------------------------------------------------------

/** Hard cap of painted regions per document (the report itself is capped per link and in total; truncation is disclosed). */
export const MAX_PROBE_REGIONS = 1500;
/** Upper bound of recorded hits of ONE PDF scan (below the session default of 50k: the overlay never paints that many anyway). */
export const MAX_PDF_SCAN_HITS = 20_000;

const scanTargets = new WeakMap<BoardIndex, { refs: Set<string>; nets: Set<string> }>();
/** Board references and net names a PDF is scanned for (exact names as the board writes them; the session does the token matching). */
export function pdfScanTargets(board: BoardIndex): { refs: Set<string>; nets: Set<string> } {
  let cached = scanTargets.get(board);
  if (!cached) {
    const refs = new Set<string>(), nets = new Set<string>();
    for (const component of board.components) if (normalizeKey(component.ref)) refs.add(component.ref);
    for (const net of board.nets) if (normalizeKey(net.name)) nets.add(net.name);
    scanTargets.set(board, cached = { refs, nets });
  }
  return cached;
}

interface RegionIndex { regions: ViewerProbeRegion[]; truncated: boolean; targets: Map<string, { link: PdfRefLink; hit: PdfLinkHit }> }
const regionCache = new WeakMap<PdfLinkReport, RegionIndex>();
/** Clickable regions of a report: every literal hit of a link that has an exact board target (duplicates stay separate regions). */
export function probeRegionsOf(report: PdfLinkReport): RegionIndex {
  let cached = regionCache.get(report);
  if (cached) return cached;
  const regions: ViewerProbeRegion[] = [], targets = new Map<string, { link: PdfRefLink; hit: PdfLinkHit }>();
  let truncated = false;
  report.links.forEach((link, linkIndex) => {
    if (link.status === 'missing') return;
    link.hits.forEach((hit, hitIndex) => {
      if (regions.length >= MAX_PROBE_REGIONS) { truncated = true; return; }
      const id = `${linkIndex}:${hitIndex}`;
      regions.push({ id, page: hit.page, rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height }, label: link.name });
      targets.set(id, { link, hit });
    });
  });
  regionCache.set(report, cached = { regions, truncated, targets });
  return cached;
}

/** Board targets of a link as an explicit-choice mapping (components only: net names cannot be told apart by name anyway). */
export function mappingOfLink(link: PdfRefLink): Mapping<BoardTarget> {
  const candidates: BoardTarget[] = [];
  for (const target of link.targets) if (target.kind === 'component') candidates.push({ componentId: target.componentId, ref: target.ref, side: target.side, via: 'exact', pin: null });
  return { status: candidates.length > 1 ? 'ambiguous' : candidates.length === 1 ? 'unique' : 'missing', candidates, total: link.targetsTotal, truncated: link.targetsTotal > candidates.length, reasons: candidates.length > 1 ? ['several-board-parts'] : [], caseInsensitive: [] };
}

const EMPTY_HIGHLIGHTS: readonly ViewerHighlight[] = Object.freeze([]);
const EMPTY_REGIONS: readonly ViewerProbeRegion[] = Object.freeze([]);
const sameRect = (a: ViewerHighlight['rect'], b: ViewerHighlight['rect']) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameHighlights = (a: readonly ViewerHighlight[], b: readonly ViewerHighlight[]) => a === b || (a.length === b.length && a.every((item, i) => item.id === b[i].id && item.kind === b[i].kind && item.page === b[i].page && item.active === b[i].active && item.label === b[i].label && sameRect(item.rect, b[i].rect)));

/** 'selection' highlights of the literal hits of the selected reference (the first one is the navigated hit). */
export function selectionHighlightsOf(report: PdfLinkReport | undefined, ref: string | null): ViewerHighlight[] {
  if (!report || !ref) return [];
  const key = normalizeKey(ref);
  const out: ViewerHighlight[] = [];
  for (const link of report.links) {
    if (normalizeKey(link.name) !== key) continue;
    link.hits.forEach((hit, i) => out.push({ id: `sel:${link.kind}:${hit.itemIndex}:${i}`, kind: 'selection', page: hit.page, rect: { x: hit.x, y: hit.y, width: hit.width, height: hit.height }, label: link.name, active: out.length === 0 }));
  }
  return out;
}

export interface OverlayInput { report?: PdfLinkReport; state: DocumentOverlay['state']; ref: string | null; extra: readonly ViewerHighlight[] }
/** Rebuilds the overlay of one document, returning `previous` itself when nothing visible changed (stable references for React). */
export function buildOverlay(previous: DocumentOverlay | undefined, input: OverlayInput): DocumentOverlay {
  const index = input.report ? probeRegionsOf(input.report) : undefined;
  const regions = index && index.regions.length ? index.regions : EMPTY_REGIONS;
  const state = input.state === 'ready' && (input.report?.truncated || input.report?.linksTruncated || index?.truncated) ? 'truncated' : input.state;
  const all = [...selectionHighlightsOf(input.report, input.ref), ...input.extra];
  const highlights = all.length ? all : EMPTY_HIGHLIGHTS;
  if (previous && previous.state === state && previous.probeRegions === regions && sameHighlights(previous.highlights, highlights)) return previous;
  return { highlights: previous && sameHighlights(previous.highlights, highlights) ? previous.highlights : highlights as ViewerHighlight[], probeRegions: regions as ViewerProbeRegion[], state };
}
