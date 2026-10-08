/*
 * Board families of the synthetic library. A family is one board (a vendor, a model, a board number) with one to four revisions,
 * each written in one to three formats, and the files a technician keeps about it: schematic PDFs, structured schematics, board
 * PDFs, BOMs, datasheets of its ICs, a service manual, photos, firmware, plus the mess around them (copies in other folders,
 * renamed and mis-named copies, truncated files, re-saved documents, archives). Everything is derived from the seed and the
 * family index, so a family does not change when another family does.
 */
import { buildEncryptedLookalike, buildFirmware, buildJpeg, buildPng, FIRMWARE_SIZES } from './binary.ts';
import { BENCH_PARTS_PER_PIN, boardFromBenchGencad } from './bench-boards.ts';
import type { BoardModel, BoardSpec, PinSet, RailStyle, RefScheme } from './board-model.ts';
import { deriveRevision, deriveSibling, fingerprintOf, generateBoard, jaccard, partNumbersOf, pinSetOf, pinSetSize, refSetOf } from './board-model.ts';
import type { BoardMeta, BoardWriter } from './board-writers.ts';
import { boardWriters } from './board-writers.ts';
import { makeNumberOfShape, nearMissNumber, pickBoardNumberShape, REVISION_SCHEMES, revisionLabels, revisionText } from './board-numbers.ts';
import type { BoardNumberShapeId, RevisionScheme } from './board-numbers.ts';
import { appendPdfUpdate, buildBoardPdf, buildDatasheetPdf, buildManualPdf, buildScannedPdf, buildSchematicPdf } from './documents.ts';
import type { PdfDoc, SchematicSpec } from './documents.ts';
import type { ArchiveEntrySpec, Engine } from './engine.ts';
import type { ItemFlag, TruthFamily, TruthRevision } from './ground-truth.ts';
import type { Collection } from './layout.ts';
import { copyFolderOf, deepChain, placeFolder } from './layout.ts';
import type { Decoration, NamedFamily } from './names.ts';
import { composeStem, decorateStem, foldForMatch, pickStyle, roleWord, styleExtension } from './names.ts';
import type { Content, Item } from './records.ts';
import type { Rng } from './rng.ts';
import { buildBomCsv, buildBomXlsx, buildKicadSchematic } from './text-docs.ts';
import type { DeviceType } from './words.ts';
import { MODEL_NUMBERS, MODEL_SUFFIXES, MODEL_WORDS, OPAQUE_STEMS, RAIL_STYLES, VENDORS } from './words.ts';

export interface FamilyMemo {
  id: string;
  vendor: string;
  model: string;
  deviceType: DeviceType;
  boardNumber: string;
  shape: BoardNumberShapeId;
  collection: number;
  /** The last revision's board (made again on demand). */
  lastBoard(): BoardModel;
}

export interface FamilyRun {
  collections: Collection[];
  chains: Map<number, string[]>;
  numbers: Set<string>;
  recent: FamilyMemo[];
  families: TruthFamily[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
/** Part counts of a board at scale 1: a geometric ladder, so sizes are spread evenly on a log scale without a transcendental function (which could differ between platforms). */
const PART_BANDS: readonly number[] = [40, 55, 75, 100, 135, 180, 240, 300];
function logUniform(u: number, bands: readonly number[]): number {
  const position = u * (bands.length - 1), low = Math.min(bands.length - 2, Math.floor(position));
  return bands[low] + (bands[low + 1] - bands[low]) * (position - low);
}
const pad4 = (n: number): string => String(n).padStart(4, '0');

/** A list that is computed when first asked for and can be dropped to free memory (it is computed again, identically, if asked once more). */
class Lazy<T> {
  #value: T | null = null;
  readonly #make: () => T;
  constructor(make: () => T) { this.#make = make; }
  get(): T { return this.#value ??= this.#make(); }
  release(): void { this.#value = null; }
}

function chooseWriters(rng: Rng, first: BoardWriter | null): BoardWriter[] {
  const all = boardWriters();
  const count = rng.weighted<number>([[1, 45], [2, 38], [3, 17]]);
  const chosen: BoardWriter[] = first ? [first] : [];
  const pool = all.filter(writer => writer !== first);
  while (chosen.length < count && pool.length) {
    const writer = rng.weighted(pool.map(candidate => [candidate, candidate.weight] as const));
    chosen.push(writer);
    pool.splice(pool.indexOf(writer), 1);
  }
  return chosen;
}

const dateText = (year: number, month: number, day: number): string => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export function generateFamily(e: Engine, run: FamilyRun, index: number): void {
  const rng = e.root.fork(`family/${index}`);
  const id = `F${pad4(index + 1)}`;
  const bench = e.options.benchGenCad ?? null;
  const benchShare = e.options.benchShare ?? 0.3;

  // ---- identity -----------------------------------------------------------------------------------------------------------
  const sibling = run.recent.length >= 4 && rng.chance(0.08) ? rng.pick(run.recent) : null;
  const reused = !sibling && run.recent.length >= 4 && rng.chance(0.06) ? rng.pick(run.recent) : null;
  const vendor = sibling?.vendor ?? reused?.vendor ?? rng.pick(VENDORS);
  const deviceType: DeviceType = sibling?.deviceType ?? reused?.deviceType ?? rng.weighted<DeviceType>([['laptop', 40], ['phone', 22], ['tablet', 8], ['console', 6], ['graphics', 10], ['monitor', 4], ['desktop', 6], ['mainboard', 4]]);
  const model = sibling ? `${sibling.model} ${rng.pick(['Pro', 'Plus', 'Mini', 'S', 'Max', 'SE'])}` : reused?.model ?? `${rng.pick(MODEL_WORDS)} ${rng.chance(0.65) ? rng.pick(MODEL_NUMBERS) : rng.pick(MODEL_SUFFIXES)}`;
  let shape: BoardNumberShapeId = sibling && rng.chance(0.4) ? sibling.shape : pickBoardNumberShape(rng.fork('shape'));
  let boardNumber = sibling && shape === sibling.shape ? nearMissNumber(sibling.boardNumber, rng.fork('near')) : makeNumberOfShape(shape, rng.fork('number'));
  for (let attempt = 0; run.numbers.has(foldForMatch(boardNumber)); attempt++) {
    shape = pickBoardNumberShape(rng.fork(`shape/${attempt}`));
    boardNumber = makeNumberOfShape(shape, rng.fork(`number/${attempt}`)) + (attempt > 8 ? rng.digits(2) : '');
  }
  run.numbers.add(foldForMatch(boardNumber));
  const schematicNumber = shape === 'logic-board-820' ? `051-${rng.digits(rng.chance(0.4) ? 5 : 4)}` : undefined;
  const scheme: RevisionScheme = rng.pick(REVISION_SCHEMES);
  const revisionCount = rng.weighted<number>([[1, 40], [2, 30], [3, 20], [4, 10]]);
  const labels = revisionLabels(scheme, revisionCount);
  const collection = sibling && rng.chance(0.6) ? run.collections[sibling.collection] : run.collections[rng.int(0, run.collections.length - 1)];
  if (collection.style === 'deep' && !run.chains.has(collection.id)) run.chains.set(collection.id, deepChain(rng.fork('chain')));
  const year = rng.int(2016, 2024), month = rng.int(1, 12);
  const named: NamedFamily = { vendor, model, boardNumber, deviceType };
  const place = { ...named, year, month };

  // ---- boards ---------------------------------------------------------------------------------------------------------------
  const parts = clamp(Math.round(logUniform(rng.next(), PART_BANDS) * e.scale), 24, 5000);
  const spec: BoardSpec = { parts, refScheme: rng.pick<RefScheme>(['gapped', 'block']), railStyle: rng.pick<RailStyle>(RAIL_STYLES as readonly RailStyle[]), alphaBga: rng.chance(0.5) };
  const useBench = !sibling && bench !== null && parts >= 60 && rng.chance(benchShare);
  const changes: Array<{ percent: number; renamed: number }> = labels.map((_, r) => ({ percent: rng.fork(`rev/${r}/percent`).int(1, 8), renamed: rng.fork(`rev/${r}/renamed`).int(0, 3) }));
  const renumber = 0.25 + rng.fork('renumber').next() * 0.1;
  const benchPins = Math.max(200, Math.round(parts / BENCH_PARTS_PER_PIN));
  const benchSeed = rng.fork('benchseed').u32();
  /** A sibling shares at most 74 % of its references with the board it was made from (so a document of one covers less than 0.8 of the other). */
  const makeSibling = (base: BoardModel): BoardModel => {
    const baseRefs = refSetOf(base);
    let share = renumber;
    for (let attempt = 0; ; attempt++) {
      const board = deriveSibling(base, e.root.fork(`${id}/sibling/${attempt}`), share);
      const refs = refSetOf(board);
      let shared = 0;
      for (const ref of refs) if (baseRefs.has(ref)) shared++;
      if ((shared / baseRefs.size <= 0.74 && shared / refs.size <= 0.74) || attempt >= 4) return board;
      share = Math.min(0.6, share + 0.1);
    }
  };
  const makeBoards = (): { boards: BoardModel[]; info: Array<{ valueChanges: number; removed: number; added: number; renamedNets: number }> } => {
    let first: BoardModel;
    if (sibling) first = makeSibling(sibling.lastBoard());
    else if (useBench && bench) first = boardFromBenchGencad(bench(benchPins, benchSeed), e.root.fork(`${id}/bench`));
    else first = generateBoard(e.root.fork(`${id}/board`), spec);
    const boards = [first];
    const info = [{ valueChanges: 0, removed: 0, added: 0, renamedNets: 0 }];
    for (let r = 1; r < labels.length; r++) {
      const next = deriveRevision(boards[r - 1], e.root.fork(`${id}/rev/${r}`), changes[r].percent, changes[r].renamed, spec);
      boards.push(next.board);
      info.push(next.change);
    }
    return { boards, info };
  };
  const boardSet = new Lazy(makeBoards);
  const boardsOf = (): BoardModel[] => boardSet.get().boards;
  const boards = boardsOf();
  const lastIndex = labels.length - 1;
  const dates = labels.map((_, r) => dateText(year + Math.floor((month - 1 + r * rng.fork(`date/${r}`).int(2, 9)) / 12), ((month - 1 + r * rng.fork(`date/${r}`).int(2, 9)) % 12) + 1, rng.fork(`day/${r}`).int(1, 28)));
  const mtimeOf = (r: number, hours = 0): number => Date.UTC(year, month - 1, 1) + (r * 100 + rng.fork(`mtime/${r}`).int(0, 60)) * 86_400_000 + hours * 3_600_000;
  const pinSets: PinSet[] = boards.map(board => pinSetOf(board));
  const truthRevisions: TruthRevision[] = labels.map((label, r) => ({
    revision: label, order: r + 1, parts: boards[r].parts.length, pins: pinSetSize(pinSets[r]), changedParts: r === 0 ? 0 : boardSet.get().info[r].valueChanges + boardSet.get().info[r].removed + boardSet.get().info[r].added,
    renamedNets: r === 0 ? 0 : boardSet.get().info[r].renamedNets, jaccardToPrevious: r === 0 ? null : Math.round(jaccard(pinSets[r - 1], pinSets[r]) * 10000) / 10000, partNumbers: partNumbersOf(boards[r]),
  }));
  const family: TruthFamily = {
    id, vendor, model, deviceType, boardNumber, boardNumberShape: shape, ...(schematicNumber ? { schematicNumber } : {}), revisionScheme: scheme, ...(sibling ? { siblingOf: sibling.id, siblingJaccard: Math.round(jaccard(pinSetOf(sibling.lastBoard()), pinSets[0]) * 10000) / 10000 } : {}),
    layout: collection.style, revisions: truthRevisions,
  };
  run.families.push(family);

  // ---- emission helpers -----------------------------------------------------------------------------------------------------
  const mine: Item[] = [];
  const created: Content[] = [];
  const track = (spec: Parameters<Engine['newContent']>[0]): Content => { const content = e.newContent(spec); created.push(content); return content; };
  const nameRng = rng.fork('names');
  let nameCounter = 0;
  const nameOf = (role: string, extension: string, r: number | null): string => {
    const prng = nameRng.fork(nameCounter++);
    const revision = r !== null && prng.chance(0.55) ? revisionText(labels[r], scheme, prng) : '';
    const stem = composeStem(pickStyle(prng, role), { boardNumber, revision, vendor, model, role: roleWord(role, prng), date: r !== null ? dates[r] : dates[0] }, prng, nameCounter);
    const decoration = prng.weighted<Decoration>([['none', 80], ['number', 5], ['copy', 2], ['copy-of', 2], ['unicode', 6], ['long', 2.5], ['bidi', 0.5]]);
    return decorateStem(stem, decoration, prng, extension.length) + styleExtension(extension, prng);
  };
  const folderOf = (role: string): string[] => placeFolder({ family: place, role, collection, chain: run.chains.get(collection.id) ?? [] }, rng.fork(`folder/${role}`));
  const emit = (content: Content, role: Parameters<Engine['addFile']>[0]['role'], name: string, revision: number | null, hours = 0, flags: ItemFlag[] = [], dir?: readonly string[]): Item | null => {
    const item = e.addFile({ dir: dir ?? folderOf(role), name, content, familyId: id, revision: revision === null ? null : labels[revision], role, flags, mtimeMs: mtimeOf(revision ?? 0, hours), named });
    if (item) mine.push(item);
    return item;
  };

  interface BoardRecord { content: Content; revision: number; pins: Set<string>; refs: Set<string> }
  interface DocRecord { content: Content; revision: number; refs: Set<string>; docOnly: number }
  const boardRecords: BoardRecord[] = [];
  const docRecords: DocRecord[] = [];
  const structured: BoardRecord[] = [];
  const pairsOf = (set: PinSet): Set<string> => { const out = new Set<string>(); for (const [ref, pins] of set) for (const pin of pins) out.add(`${ref}\u0000${pin}`); return out; };

  const usedFormats = new Set<string>();
  const addBoard = (r: number, writer: BoardWriter): Content => {
    const meta: BoardMeta = { boardNumber, revision: labels[r], title: `${vendor} ${model} mainboard`, vendor, date: dates[r], includeHeader: writer.hasHeader && rng.fork(`hdr/${r}/${writer.id}`).chance(0.55), valueStyle: rng.fork(`vs/${r}/${writer.id}`).chance(0.25) ? 'ref-prefixed' : 'plain' };
    const board = boards[r];
    const set = pinSetOf(board, writer.numbering);
    const mpns = partNumbersOf(board).map(entry => entry.exact.toUpperCase());
    const content = track({
      kind: 'board', format: writer.id, ...(writer.variant ? { variant: writer.variant } : {}), role: 'board', familyId: id, revision: labels[r], ...(meta.includeHeader ? { idEvidence: 'header-id' as const } : {}),
      fingerprint: fingerprintOf(set), pinSetSize: pinSetSize(set), refCount: board.parts.length, ...(writer.carriesValues && mpns.length ? { partNumbers: mpns } : {}),
      build: () => writer.write(boardsOf()[r], meta, e.root.fork(`${id}/write/${r}/${writer.id}`)),
    });
    boardRecords.push({ content, revision: r, pins: pairsOf(set), refs: refSetOf(board) });
    return content;
  };
  const addBoardFile = (r: number, writer: BoardWriter): Content | null => {
    if (!e.hasRoom()) return null;
    const content = addBoard(r, writer);
    usedFormats.add(`${r}/${writer.id}`);
    return emit(content, 'board', nameOf('board', writer.extensions[0], r), r, 0) ? content : null;
  };

  const schematicParams = (r: number) => {
    const prng = rng.fork(`sch/${r}`);
    const variant = prng.weighted<'full' | 'partial' | 'loose'>([['full', 62], ['partial', 22], ['loose', 16]]);
    const printed = boardsOf()[r].parts.length;
    return {
      pages: clamp(Math.ceil(printed / prng.int(30, 70)), 1, 120),
      coverage: variant === 'partial' ? 0.55 + prng.next() * 0.23 : 0.9 + prng.next() * 0.1,
      docOnlyShare: variant === 'loose' ? 0.2 + prng.next() * 0.2 : prng.next() * 0.08,
      titleBlockId: prng.chance(0.65), fillerPerPage: prng.int(4, 20), outline: prng.chance(0.4),
    };
  };
  const schematicSpec = (r: number, extra: Partial<SchematicSpec> = {}): SchematicSpec => ({
    board: boardsOf()[r], revision: labels[r], boardNumber, ...(schematicNumber ? { schematicNumber } : {}), model, vendor, date: dates[r], ...schematicParams(r), ...extra,
  });
  const noteDocument = (content: Content, doc: PdfDoc, r: number): void => {
    const boardRefs = refSetOf(boards[r]);
    const docRefs = new Set(doc.refs);
    let found = 0;
    for (const ref of docRefs) if (boardRefs.has(ref)) found++;
    content.coverage = Math.round((found / boardRefs.size) * 1000) / 1000;
    docRecords.push({ content, revision: r, refs: docRefs, docOnly: docRefs.size ? (docRefs.size - found) / docRefs.size : 0 });
  };
  const addSchematic = (r: number, extra: Partial<SchematicSpec> = {}, flags: ItemFlag[] = [], suffix = ''): Content | null => {
    if (!e.hasRoom()) return null;
    const make = (): PdfDoc => buildSchematicPdf(schematicSpec(r, extra), e.root.fork(`${id}/sch/${r}${suffix}`));
    const doc = make();
    const locked = extra.password !== undefined;
    const content = track({
      kind: 'pdf', format: 'pdf', role: 'schematic', familyId: id, revision: labels[r], flags: [...flags, ...(locked ? (['password-protected', 'encrypted'] as ItemFlag[]) : [])],
      ...(!locked ? {
        ...(doc.titleIds.length ? { idEvidence: 'title-id' as const } : {}), partNumbers: doc.partNumbers, decoys: doc.decoys, refCount: doc.refs.length, pages: doc.pages,
      } : { pages: doc.pages }),
      build: () => make().bytes, prebuilt: doc.bytes,
    });
    if (!emit(content, 'schematic', nameOf('schematic', '.pdf', r), r, 24)) return null;
    if (!locked) noteDocument(content, doc, r);
    return content;
  };

  // ---- revisions: boards first, then schematics ----------------------------------------------------------------------------
  const formats: BoardWriter[][] = labels.map((_, r) => {
    const gencad = boardWriters().find(writer => writer.id === 'gencad') ?? null;
    return chooseWriters(rng.fork(`fmt/${r}`), r === 0 && useBench ? gencad : null);
  });
  for (let r = 0; r < labels.length; r++) addBoardFile(r, formats[r][0]);
  const schematicRevisions = new Set<number>();
  for (let r = 0; r < labels.length; r++) if (rng.fork(`wantsch/${r}`).chance(r === lastIndex ? 0.85 : 0.55)) schematicRevisions.add(r);
  const schematics = new Map<number, Content>();
  for (const r of schematicRevisions) { const content = addSchematic(r); if (content) schematics.set(r, content); }
  for (let r = 0; r < labels.length; r++) for (const writer of formats[r].slice(1)) addBoardFile(r, writer);

  // ---- other documents -------------------------------------------------------------------------------------------------------
  for (let r = 0; r < labels.length && e.hasRoom(); r++) {
    const prng = rng.fork(`extras/${r}`);
    if (boards[r].parts.length >= 30 && prng.chance(0.25)) {
      const make = (): PdfDoc => buildBoardPdf({ board: boardsOf()[r], boardNumber, revision: labels[r], model, printTitle: prng.fork('title').chance(0.5) });
      const doc = make();
      const content = track({ kind: 'pdf', format: 'pdf', role: 'board-pdf', familyId: id, revision: labels[r], ...(doc.titleIds.length ? { idEvidence: 'title-id' as const } : {}), decoys: doc.decoys, refCount: doc.refs.length, pages: doc.pages, build: () => make().bytes, prebuilt: doc.bytes });
      if (emit(content, 'board-pdf', nameOf('board-pdf', '.pdf', r), r, 30)) noteDocument(content, doc, r);
    }
    if (prng.chance(0.12) && e.hasRoom()) {
      const withNumber = prng.fork('kn').chance(0.7);
      const content = track({
        kind: 'schematic', format: 'kicad_sch', role: 'schematic', familyId: id, revision: labels[r], ...(withNumber ? { idEvidence: 'title-id' as const } : {}), refCount: boards[r].parts.length,
        build: () => buildKicadSchematic({ board: boardsOf()[r], title: `${vendor} ${model} mainboard`, revision: labels[r], company: vendor, date: dates[r], boardNumber, includeBoardNumber: withNumber }, e.root.fork(`${id}/ksch/${r}`)),
      });
      if (emit(content, 'schematic', nameOf('schematic', '.kicad_sch', r), r, 26)) structured.push({ content, revision: r, pins: pairsOf(pinSets[r]), refs: refSetOf(boards[r]) });
    }
    if (prng.chance(0.3) && e.hasRoom()) {
      const includeTitle = prng.fork('bt').chance(0.6), xlsx = prng.fork('bx').chance(0.3);
      const bomSpec = (): Parameters<typeof buildBomCsv>[0] => ({ board: boardsOf()[r], boardNumber, revision: labels[r], title: `${vendor} ${model}`, includeTitle });
      const mpns = partNumbersOf(boards[r]).map(entry => entry.exact.toUpperCase());
      const content = track({
        kind: 'spreadsheet', format: xlsx ? 'xlsx' : 'csv', role: 'bom', familyId: id, revision: labels[r], ...(mpns.length ? { partNumbers: mpns } : {}), refCount: boards[r].parts.length,
        evidence: includeTitle ? ['bom-title'] : [], build: () => (xlsx ? buildBomXlsx(bomSpec()) : buildBomCsv(bomSpec())),
      });
      emit(content, 'bom', nameOf('bom', xlsx ? '.xlsx' : '.csv', r), r, 20);
    }
  }

  // datasheets of the ICs (about a part, not about the board: no family)
  if (e.hasRoom() && rng.chance(0.45)) {
    const ics = partNumbersOf(boards[lastIndex]);
    for (const entry of rng.sample(ics, rng.int(1, 3))) {
      if (!e.hasRoom()) break;
      const prng = rng.fork(`ds/${entry.exact}`);
      const dsSpec = { mpn: entry.exact, pages: clamp(Math.round(prng.int(4, 30) * Math.sqrt(e.scale)), 2, 80), variants: prng.int(0, 3) };
      const make = (): PdfDoc => buildDatasheetPdf(dsSpec, e.root.fork(`${id}/ds/${entry.exact}`));
      const doc = make();
      const content = track({ kind: 'pdf', format: 'pdf', role: 'datasheet', familyId: null, revision: null, partNumbers: doc.partNumbers, decoys: doc.decoys, pages: doc.pages, build: () => make().bytes, prebuilt: doc.bytes });
      const stemChoice = prng.pick([entry.base, `${entry.base} datasheet`, `${entry.base}_DS`, `datasheet ${entry.base}`]);
      const item = e.addFile({ dir: folderOf('datasheet'), name: `${stemChoice}.pdf`, content, familyId: null, revision: null, role: 'datasheet', mtimeMs: mtimeOf(0, 5), named: null });
      if (item) mine.push(item);
    }
  }
  // service manual
  if (e.hasRoom() && rng.chance(0.25)) {
    const prng = rng.fork('manual');
    const withNumber = prng.chance(0.5);
    const manualSpec = { model, vendor, pages: clamp(Math.round(prng.int(3, 30) * Math.sqrt(e.scale)), 2, 120), ...(withNumber ? { boardNumber } : {}) };
    const make = (): PdfDoc => buildManualPdf(manualSpec, e.root.fork(`${id}/manual`));
    const doc = make();
    const content = track({ kind: 'pdf', format: 'pdf', role: 'service-manual', familyId: id, revision: null, decoys: doc.decoys, pages: doc.pages, evidence: withNumber ? ['prose-mention'] : [], build: () => make().bytes, prebuilt: doc.bytes });
    emit(content, 'service-manual', nameOf('service-manual', '.pdf', null), null, 40);
  }
  // photos
  if (e.hasRoom() && rng.chance(0.3)) {
    for (let k = rng.int(1, 4); k > 0 && e.hasRoom(); k--) {
      const prng = rng.fork(`photo/${k}`);
      const png = prng.chance(0.5);
      const photoSpec = { width: prng.int(32, 96), height: prng.int(24, 72), padBytes: Math.round(prng.int(5_000, 120_000) * Math.sqrt(e.scale)) };
      const content = track({ kind: 'image', format: png ? 'png' : 'jpeg', role: 'photo', familyId: id, revision: null, build: () => (png ? buildPng : buildJpeg)(e.root.fork(`${id}/photo/${k}`), photoSpec) });
      const stem = `${prng.pick(['IMG', 'DSC', 'PXL', 'photo', 'IMG_'])}${prng.pick(['_', ' ', ''])}${prng.int(1, 9999)}`;
      emit(content, 'photo', `${stem}${png ? '.png' : prng.pick(['.jpg', '.jpeg', '.JPG'])}`, null, 60);
    }
  }
  // firmware
  if (e.hasRoom() && rng.chance(0.2)) {
    const sizes = FIRMWARE_SIZES.filter(size => size <= (e.options.bytes / e.options.files) * 8);
    if (sizes.length) {
      const prng = rng.fork('firmware');
      const size = prng.pick(sizes);
      const content = track({ kind: 'firmware', format: 'firmware', role: 'firmware', familyId: id, revision: null, build: () => buildFirmware(e.root.fork(`${id}/firmware`), size) });
      const stem = prng.pick([`${model} BIOS`, `bios_${boardNumber}`, `${vendor}_${model}_EC`, `dump`, `flash_${prng.int(1, 99)}`, `${boardNumber} ${prng.pick(['bios', 'ec', 'rom'])}`]);
      emit(content, 'firmware', `${stem}${prng.pick(['.bin', '.bin', '.rom', '.cap', '.fd'])}`, null, 70);
    }
  }
  // encrypted-looking boardview files (the key is not in the library)
  if (e.hasRoom() && rng.chance(0.05)) {
    const prng = rng.fork('encrypted');
    const kind = prng.pick(['fz', 'xzz', 'cae'] as const);
    const size = Math.round(prng.int(20_000, 400_000) * Math.min(e.scale, 8));
    const content = track({ kind: 'board', format: kind === 'xzz' ? 'xzz' : 'fz', role: 'board', familyId: id, revision: null, flags: ['encrypted'], needsKey: kind === 'xzz' ? 'xzz' : 'fz', build: () => buildEncryptedLookalike(e.root.fork(`${id}/encrypted`), kind, size) });
    emit(content, 'board', nameOf('board', `.${kind}`, null), null, 10);
  }
  // password-protected and scanned schematics
  if (e.hasRoom() && rng.chance(0.05) && schematicRevisions.size) addSchematic(lastIndex, { password: 'synthetic', outline: false, titleBlockId: true }, [], '/locked');
  if (e.hasRoom() && rng.chance(0.05)) {
    const pages = rng.int(1, 6);
    const content = track({ kind: 'pdf', format: 'pdf', role: 'schematic', familyId: id, revision: labels[lastIndex], flags: ['scanned'], pages, build: () => appendPdfUpdate(buildScannedPdf(pages).bytes, { info: { title: `Scan ${id}`, producer: `Synthetic Scanner ${index % 7}` } }) });
    emit(content, 'schematic', nameOf('schematic', '.pdf', lastIndex), lastIndex, 90);
  }
  // a re-saved schematic: other bytes, the same text
  if (e.hasRoom(2) && schematics.size && rng.chance(0.08)) {
    const [revision, original] = rng.pick([...schematics]);
    const prng = rng.fork('resave');
    const update = { info: { title: `${model} schematic`, producer: prng.pick(['Synthetic Resaver 2', 'Print to PDF', 'Document Merger 4']) }, padding: prng.bytes(prng.int(200, 6000)) };
    const content = track({
      kind: 'pdf', format: 'pdf', role: 'schematic', familyId: id, revision: labels[revision], flags: ['resaved'], ...(original.idEvidence ? { idEvidence: original.idEvidence } : {}),
      ...(original.partNumbers ? { partNumbers: original.partNumbers } : {}), ...(original.decoys ? { decoys: original.decoys } : {}), refCount: original.refCount, pages: original.pages, coverage: original.coverage,
      build: () => appendPdfUpdate(e.bytesOf(original), update),
    });
    if (emit(content, 'schematic', nameOf('schematic', '.pdf', revision), revision, 100)) {
      e.resaved.push([original.id, content.id]);
      e.union(original, content, 'duplicate-content');
      const record = docRecords.find(entry => entry.content === original);
      if (record) docRecords.push({ ...record, content });
    }
  }

  // ---- archives --------------------------------------------------------------------------------------------------------------
  if (e.hasRoom(2) && rng.chance(0.12)) {
    const prng = rng.fork('zip');
    const extraWriter = boardWriters().find(writer => !usedFormats.has(`${lastIndex}/${writer.id}`) && writer.id !== 'pinlist');
    const entries: ArchiveEntrySpec[] = [];
    const loose = mine.filter(item => item.role === 'board' || item.role === 'schematic');
    for (const item of prng.sample(loose, prng.int(1, 2))) entries.push({ name: item.path.split('/').pop()!, content: e.contents.get(item.contentId)!, role: item.role, revision: item.revision, familyId: id });
    if (extraWriter && prng.chance(0.5)) {
      const content = addBoard(lastIndex, extraWriter);
      usedFormats.add(`${lastIndex}/${extraWriter.id}`);
      entries.unshift({ name: nameOf('board', extraWriter.extensions[0], lastIndex), content, role: 'board', revision: labels[lastIndex], familyId: id });
    }
    const names = new Set<string>();
    const unique = entries.filter(entry => (names.has(entry.name.toLowerCase()) ? false : (names.add(entry.name.toLowerCase()), true)));
    if (unique.length && prng.chance(0.3)) {
      const stub = track({ kind: 'unknown', format: null, role: 'other', familyId: null, revision: null, flags: ['macos-junk'], build: () => e.root.fork(`${id}/junk`).bytes(120) });
      unique.push({ name: `__MACOSX/._${unique[0].name}`, content: stub, role: 'other', familyId: null, flags: ['macos-junk'] });
    }
    if (unique.length) {
      const result = e.addArchive({
        dir: folderOf('archive'), name: `${prng.pick([model, boardNumber, `${vendor} ${model} files`, `download ${prng.int(1, 99)}`])}.zip`, familyId: id, revision: null, mtimeMs: mtimeOf(lastIndex, 120), named, entries: unique,
      });
      if (result) mine.push(result.archive);
    }
  }

  // ---- strong evidence between the family's contents ----------------------------------------------------------------------------
  const withId = created.filter(content => content.familyId === id && content.idEvidence && content.size !== undefined && !content.flags.includes('truncated'));
  if (withId.length >= 2 && withId.length <= 50) for (let k = 1; k < withId.length; k++) e.union(withId[0], withId[k], withId[k].idEvidence!);
  const byFingerprint = new Map<string, Content>();
  for (const record of boardRecords) {
    if (record.content.size === undefined) continue;
    const key = record.content.fingerprint!;
    const known = byFingerprint.get(key);
    if (known) e.union(known, record.content, 'fingerprint'); else byFingerprint.set(key, record.content);
  }
  const emittedBoards = boardRecords.filter(record => record.content.size !== undefined);
  for (const doc of docRecords) {
    if (doc.content.size === undefined) continue;
    for (const board of emittedBoards) {
      let found = 0;
      for (const ref of doc.refs) if (board.refs.has(ref)) found++;
      const coverage = found / board.refs.size, docOnly = doc.refs.size ? (doc.refs.size - found) / doc.refs.size : 0;
      if (coverage >= 0.8 && found >= 30 && docOnly <= 0.15) e.union(doc.content, board.content, 'coverage');
      else if (coverage >= 0.5 && found >= 20) doc.content.evidence.add('partial-coverage');
    }
  }
  for (const sch of structured) {
    if (sch.content.size === undefined) continue;
    for (const board of emittedBoards) {
      let shared = 0;
      for (const pair of sch.pins) if (board.pins.has(pair)) shared++;
      const union = sch.pins.size + board.pins.size - shared;
      if (union > 0 && shared / union >= 0.9) e.union(sch.content, board.content, 'structured-link');
    }
  }
  for (let a = 0; a < emittedBoards.length; a++) for (let b = a + 1; b < emittedBoards.length; b++) {
    const x = emittedBoards[a], y = emittedBoards[b];
    if (x.content.fingerprint === y.content.fingerprint) continue;
    let shared = 0;
    for (const pair of x.pins) if (y.pins.has(pair)) shared++;
    if (shared / (x.pins.size + y.pins.size - shared) >= 0.6) { x.content.evidence.add('revision-fingerprint'); y.content.evidence.add('revision-fingerprint'); }
  }

  // ---- the mess: copies, renamed and mis-named copies, truncated files --------------------------------------------------------------
  const copyRng = rng.fork('copies');
  const originals = mine.filter(item => !item.container && (item.role === 'board' || item.role === 'schematic' || item.role === 'datasheet' || item.role === 'service-manual' || item.role === 'bom' || item.role === 'firmware' || item.role === 'photo'));
  for (const item of originals) {
    if (!e.hasRoom()) break;
    const prng = copyRng.fork(item.id);
    if (!prng.chance(collection.duplicateRate * 1.15)) continue;
    const content = e.contents.get(item.contentId)!;
    const base = item.path.split('/');
    const original = base[base.length - 1];
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original, extension = dot > 0 ? original.slice(dot) : '';
    const flags: ItemFlag[] = ['copy'];
    let name = original;
    const roll = prng.next();
    if (roll < 0.35) name = original;
    else if (roll < 0.55) name = `${stem} (${prng.int(1, 4)})${extension}`;
    else if (roll < 0.65) name = `${stem} - Copy${extension}`;
    else if (roll < 0.72) name = `Copy of ${original}`;
    else if (roll < 0.88) { name = `${prng.pick(OPAQUE_STEMS)}${prng.pick([' ', '_', ''])}${prng.int(1, 99)}${extension}`; flags.push('renamed-copy'); }
    else if (roll < 0.95 && (item.role === 'board' || item.role === 'schematic')) { name = `${stem}${prng.pick(['.txt', '.dat', '.bak', '.old', '.tmp'])}`; flags.push('wrong-extension'); }
    else { name = stem; flags.push('no-extension'); }
    const folder = copyFolderOf(base.slice(0, -1), collection, prng.fork('folder'));
    const copy = e.addFile({ dir: folder, name, content, familyId: item.familyId, revision: item.revision, role: item.role, flags, mtimeMs: item.mtimeMs + 86_400_000 * prng.int(1, 400), named: flags.includes('renamed-copy') ? null : named });
    if (copy) mine.push(copy);
  }
  for (const item of originals) {
    if (!e.hasRoom()) break;
    const prng = copyRng.fork(`truncate/${item.id}`);
    if (!(item.role === 'board' || item.role === 'schematic') || !prng.chance(0.03)) continue;
    const source = e.contents.get(item.contentId)!;
    if (!source.size || source.size < 3000 || source.flags.includes('encrypted')) continue;
    const keep = Math.floor(source.size * (0.35 + prng.next() * 0.55));
    const content = track({ kind: source.kind, format: source.format, ...(source.variant ? { variant: source.variant } : {}), role: source.role, familyId: id, revision: source.revision, flags: ['truncated'], build: () => e.bytesOf(source).slice(0, keep) });
    const base = item.path.split('/');
    const dot = base[base.length - 1].lastIndexOf('.');
    const stem = dot > 0 ? base[base.length - 1].slice(0, dot) : base[base.length - 1];
    const copy = e.addFile({ dir: copyFolderOf(base.slice(0, -1), collection, prng.fork('folder')), name: `${stem} (${prng.int(1, 4)})${dot > 0 ? base[base.length - 1].slice(dot) : ''}`, content, familyId: id, revision: item.revision, role: item.role, flags: [], mtimeMs: item.mtimeMs + 86_400_000, named });
    if (copy) mine.push(copy);
  }

  boardSet.release();
  // the builders of the family's contents keep this scope alive until the library is finished: let go of what is big
  boards.length = 0; pinSets.length = 0; boardRecords.length = 0; docRecords.length = 0; structured.length = 0;
  run.recent.push({ id, vendor, model, deviceType, boardNumber, shape, collection: collection.id, lastBoard: () => makeBoards().boards[lastIndex] });
  if (run.recent.length > 64) run.recent.shift();
}
