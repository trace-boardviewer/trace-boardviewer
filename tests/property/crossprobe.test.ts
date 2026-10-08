import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildBoardIndex, buildSchematicIndex, compileAliases, linkBoardSchematic, mapBoardNetToSchematic, mapBoardSelectionToSchematic, mapSchematicNetToBoard, mapSchematicSelectionToBoard,
  naturalCompare, normalizeKey, normalizeQuery, searchAll, SEARCH_TIERS,
} from '../../src/lib/crossprobe';
import type { LinkReport, RefLinkRow } from '../../src/lib/crossprobe';
import { symbolKey } from '../../src/lib/schematic/model';
import { makeBoard, makeDesign } from './builders';
import type { BoardPartSpec, SchPartSpec } from './builders';
import { params, shuffled, shuffleKeys } from './support';

// A pool that is full of near-misses on purpose: R1 / R10 (partial names), R1 / r1 (case), a full-width spelling that NFKC folds onto R1,
// a padded one, the empty reference, and so on.
const REFS = ['R1', 'R10', 'R2', 'r1', 'C1', 'U1', 'u1', 'TP1', 'Ｒ１', ' R1 ', '', 'R1.1', 'R'];
const PINS = ['1', '2', '3', '10', 'A1', 'a1', 'Ａ１', ' 2 '];
const NETS = ['GND', 'gnd', 'VCC', '+3V3', 'SDA', 'NET1', 'NET10', 'net1', ''];
const BOARD_NETS = [...NETS, ' VCC ', ' GND'];

const boardPart: fc.Arbitrary<BoardPartSpec> = fc.record({
  ref: fc.constantFrom(...REFS),
  pins: fc.array(fc.tuple(fc.constantFrom(...PINS, ''), fc.constantFrom(...BOARD_NETS)), { maxLength: 5 }),
  side: fc.constantFrom('top' as const, 'bottom' as const, 'both' as const),
});
const schPart: fc.Arbitrary<SchPartSpec> = fc.record({
  ref: fc.constantFrom(...REFS.filter(ref => ref !== '')),
  pins: fc.uniqueArray(fc.constantFrom(...PINS), { maxLength: 5 }).chain(numbers => fc.tuple(...numbers.map(n => fc.constantFrom(...NETS).map(net => [n, net] as const)))),
});
const boardParts = fc.array(boardPart, { maxLength: 8 });
const schParts = fc.array(schPart, { maxLength: 8 });

const fold = (text: string) => text.toLowerCase();
const rowsOf = (report: LinkReport) => report.refs.rows;
const byStatus = (rows: RefLinkRow[], status: RefLinkRow['status']) => rows.filter(row => row.status === status);

describe('natural order and identity keys', () => {
  const text = fc.oneof(fc.string({ maxLength: 12 }), fc.stringMatching(/^[A-Za-z]{0,3}[0-9]{0,4}[A-Za-z]{0,2}$/), fc.constantFrom('R1', 'R2', 'R10', 'R01', 'r1', 'R1a', ''));

  it('naturalCompare is a total order: antisymmetric, transitive, zero only for equal strings, and numeric inside the text', () => {
    fc.assert(fc.property(text, text, text, (a, b, c) => {
      const ab = Math.sign(naturalCompare(a, b)), ba = Math.sign(naturalCompare(b, a));
      expect(ab + ba).toBe(0);
      expect(naturalCompare(a, a)).toBe(0);
      expect(ab === 0).toBe(a === b);
      if (naturalCompare(a, b) <= 0 && naturalCompare(b, c) <= 0) expect(naturalCompare(a, c)).toBeLessThanOrEqual(0);
    }), params(400));
    fc.assert(fc.property(fc.stringMatching(/^[A-Z]{1,3}$/), fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (prefix, n, delta) => {
      expect(naturalCompare(`${prefix}${n}`, `${prefix}${n + delta}`)).toBeLessThan(0);
    }), params(200));
  });

  it('normalizeKey is idempotent, trims, folds compatibility forms and keeps case', () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), s => {
      const key = normalizeKey(s);
      expect(normalizeKey(key)).toBe(key);
      expect(key).toBe(key.trim());
      expect(normalizeKey(` ${s}\t`)).toBe(key);
    }), params(300));
    expect(normalizeKey('Ｒ１')).toBe('R1');
    expect(normalizeKey('r1')).not.toBe(normalizeKey('R1'));
    fc.assert(fc.property(fc.string({ maxLength: 40 }), s => {
      const q = normalizeQuery(s);
      expect(normalizeQuery(q)).toBe(q);
      expect(/\s{2,}/u.test(q)).toBe(false);
    }), params(200));
  });
});

describe('link report: board <-> schematic', () => {
  /** Expected relation of every reference key, read from the specs alone. */
  function model(board: readonly BoardPartSpec[], sch: readonly SchPartSpec[]) {
    const b = new Map<string, number>(), s = new Map<string, number>();
    for (const part of board) { const key = normalizeKey(part.ref); if (key) b.set(key, (b.get(key) ?? 0) + 1); }
    for (const part of sch) { const key = normalizeKey(part.ref); if (key) s.set(key, (s.get(key) ?? 0) + 1); }
    return { b, s, keys: new Set([...b.keys(), ...s.keys()]) };
  }

  it('links a reference only when the normalized names are EQUAL, never R1 with R10 or R with R1, and reports case-only twins as flagged candidates', () => {
    fc.assert(fc.property(boardParts, schParts, (board, sch) => {
      const report = linkBoardSchematic(buildBoardIndex(makeBoard(board)), buildSchematicIndex([makeDesign(sch)]));
      const { b, s, keys } = model(board, sch);
      const rows = rowsOf(report);
      expect(report.refs.truncated).toBe(false);
      // Every key is judged once, by exact equality.
      expect(report.refs.total).toBe(keys.size);
      const common = [...keys].filter(key => b.has(key) && s.has(key));
      const both = (key: string) => (b.get(key) ?? 0) === 1 && (s.get(key) ?? 0) === 1;
      expect(report.summary.refs.unique).toBe(common.filter(both).length);
      expect(report.summary.refs.ambiguous).toBe(common.filter(key => !both(key)).length);
      expect(report.summary.refs.boardOnly).toBe([...b.keys()].filter(key => !s.has(key)).length);
      expect(report.summary.refs.schematicOnly).toBe([...s.keys()].filter(key => !b.has(key)).length);
      expect(report.summary.refs.alias).toBe(0);
      for (const row of byStatus(rows, 'unique')) {
        const key = normalizeKey(row.ref);
        expect(both(key)).toBe(true);
        expect(row.schematicRefs.map(normalizeKey)).toEqual([key]);
        expect(row.caseInsensitive).toEqual({ boardRefs: [], schematicRefs: [] });
      }
      // Case-only twins on the other side are flagged, as exactly the keys that differ in nothing but case, and never linked.
      for (const row of byStatus(rows, 'board-only')) {
        const key = normalizeKey(row.ref);
        expect(row.caseInsensitive.schematicRefs.slice().sort()).toEqual([...s.keys()].filter(k => fold(k) === fold(key) && k !== key).sort().slice(0, 16));
        expect(s.has(key)).toBe(false);
      }
      for (const row of byStatus(rows, 'schematic-only')) {
        const key = normalizeKey(row.ref);
        expect(row.caseInsensitive.boardRefs.slice().sort()).toEqual([...b.keys()].filter(k => fold(k) === fold(key) && k !== key).sort().slice(0, 16));
        expect(b.has(key)).toBe(false);
      }
      // Pins are compared only for unique references.
      for (const pin of report.pins.rows) expect(both(normalizeKey(pin.ref))).toBe(true);
    }), params(300));
  });

  it('judges every pin of a unique reference by exact net names (the specification, restated from the specs)', () => {
    fc.assert(fc.property(boardParts, schParts, (board, sch) => {
      const report = linkBoardSchematic(buildBoardIndex(makeBoard(board)), buildSchematicIndex([makeDesign(sch)]), undefined, { includeMatches: true, maxPinRows: 5000 });
      const { b, s } = model(board, sch);
      const expected = { match: 0, netDiffers: 0, missingOnBoard: 0, missingOnSchematic: 0, ambiguous: 0, unknown: 0 };
      let compared = 0;
      for (const key of [...b.keys()].filter(k => b.get(k) === 1 && s.get(k) === 1)) {
        const boardSpec = board.find(part => normalizeKey(part.ref) === key)!, schSpec = sch.find(part => normalizeKey(part.ref) === key)!;
        const boardPins = new Map<string, Set<string>>();
        for (const [number, net] of boardSpec.pins) {
          const n = normalizeKey(number);
          if (!n) continue;
          const nets = boardPins.get(n) ?? new Set<string>();
          if (normalizeKey(net)) nets.add(normalizeKey(net));
          boardPins.set(n, nets);
        }
        // Several symbol pins can share a normalized number (' 2 ' and '2'): their connected copies must agree on one net.
        const schPins = new Map<string, Set<string>>();
        for (const [number, net] of schSpec.pins) {
          const n = normalizeKey(number);
          if (!n) continue;
          const nets = schPins.get(n) ?? new Set<string>();
          if (net) nets.add(net);
          schPins.set(n, nets);
        }
        for (const number of new Set([...boardPins.keys(), ...schPins.keys()])) {
          compared++;
          const nets = boardPins.get(number), schNets = schPins.get(number);
          if (nets && schNets === undefined) { expected.missingOnSchematic++; continue; }
          if (!nets) { expected.missingOnBoard++; continue; }
          if (nets.size > 1 || schNets!.size > 1) { expected.ambiguous++; continue; }
          const boardNet = [...nets][0] ?? '', schNet = [...schNets!][0] ?? '';
          if (!boardNet && !schNet) expected.match++;
          else if (!boardNet || !schNet) expected.netDiffers++;
          else if (boardNet === schNet) expected.match++;
          else expected.netDiffers++;
        }
      }
      expect(report.summary.pins).toMatchObject({ compared, match: expected.match, netDiffers: expected.netDiffers, pinMissingOnBoard: expected.missingOnBoard, pinMissingOnSchematic: expected.missingOnSchematic, ambiguous: expected.ambiguous, netUnknown: 0 });
      expect(report.pins.total).toBe(compared);
    }), params(300));
  });

  it('is independent of the order of the components and symbols', () => {
    fc.assert(fc.property(boardParts, schParts, shuffleKeys, shuffleKeys, (board, sch, k1, k2) => {
      const a = linkBoardSchematic(buildBoardIndex(makeBoard(board)), buildSchematicIndex([makeDesign(sch)]));
      const b = linkBoardSchematic(buildBoardIndex(makeBoard(shuffled(board, k1))), buildSchematicIndex([makeDesign(shuffled(sch, k2))]));
      expect(b.summary).toEqual(a.summary);
      const shape = (report: LinkReport) => report.refs.rows.map(row => [row.status, normalizeKey(row.ref), row.boardComponentsTotal, row.schematicPartsTotal, row.reasons.slice().sort()]);
      expect(shape(b)).toEqual(shape(a));
    }), params(200));
  });

  it('links two spellings only through an explicit alias, and the alias row never also appears as an exact link', () => {
    const aliasPairs = fc.array(fc.tuple(fc.constantFrom(...REFS.filter(ref => ref !== '')), fc.constantFrom(...REFS.filter(ref => ref !== ''))), { maxLength: 3 });
    fc.assert(fc.property(boardParts, schParts, aliasPairs, (board, sch, pairs) => {
      const refs = Object.fromEntries(pairs.map(([from, to]) => [from, to]));
      const aliases = { refs, nets: {} };
      const compiled = compileAliases(aliases);
      const report = linkBoardSchematic(buildBoardIndex(makeBoard(board)), buildSchematicIndex([makeDesign(sch)]), aliases);
      const { b, s } = model(board, sch);
      for (const row of byStatus(rowsOf(report), 'alias')) {
        // The board side is the alias target; each schematic part is either aliased to it or has exactly its name (and is then not aliased away).
        const target = normalizeKey(row.ref);
        expect(b.has(target)).toBe(true);
        expect(row.schematicParts.some(part => part.via === 'alias')).toBe(true);
        for (const part of row.schematicParts) {
          const key = normalizeKey(part.ref);
          if (part.via === 'alias') expect(compiled.refs.get(key)).toBe(target);
          else { expect(key).toBe(target); expect(compiled.refs.has(key)).toBe(false); }
        }
      }
      // A reference with an alias is never matched by its own name any more (the alias overrides the exact name).
      for (const row of byStatus(rowsOf(report), 'unique')) expect(compiled.refs.has(normalizeKey(row.ref))).toBe(false);
      // Without a matching alias the report equals the one without any aliases.
      if (![...compiled.refs.keys()].some(from => s.has(from))) {
        const plain = linkBoardSchematic(buildBoardIndex(makeBoard(board)), buildSchematicIndex([makeDesign(sch)]));
        expect(report.summary.refs).toEqual(plain.summary.refs);
      }
    }), params(250));
  });
});

describe('selection mapping', () => {
  it('maps a board selection only to schematic parts of the same name; case-only twins are offered, flagged, and only when nothing matches exactly', () => {
    fc.assert(fc.property(boardParts, schParts, (board, sch) => {
      const boardModel = makeBoard(board), index = buildBoardIndex(boardModel), schematic = buildSchematicIndex([makeDesign(sch)]);
      for (const component of boardModel.components) {
        const key = normalizeKey(component.ref);
        const found = mapBoardSelectionToSchematic(index, schematic, { componentId: component.id });
        for (const target of found.candidates) { expect(normalizeKey(target.ref)).toBe(key); expect(target.via).toBe('exact'); }
        if (found.caseInsensitive.length) {
          expect(found.candidates).toHaveLength(0);
          for (const twin of found.caseInsensitive) { expect(twin.via).toBe('case-insensitive'); expect(fold(normalizeKey(twin.ref))).toBe(fold(key)); expect(normalizeKey(twin.ref)).not.toBe(key); }
        }
        const sameName = sch.filter(part => normalizeKey(part.ref) === key).length;
        expect(found.total).toBe(key ? sameName : 0);
        expect(found.status).toBe(found.total === 0 ? 'missing' : found.reasons.length ? 'ambiguous' : 'unique');
        if (found.status === 'unique') {
          expect(found.total).toBe(1);
          expect(index.byRef.get(key)).toHaveLength(1);
        }
        // Pin level: the pin number is the normalized one and the part must have it.
        for (const pinId of component.pinIds) {
          const pin = boardModel.pins.find(p => p.id === pinId)!;
          const pinned = mapBoardSelectionToSchematic(index, schematic, { componentId: component.id, pinId });
          const number = normalizeKey(pin.number);
          if (!number) { expect(pinned.status).toBe('missing'); expect(pinned.reasons).toEqual(['unknown-pin']); continue; }
          for (const target of pinned.candidates) expect(target.pin?.number).toBe(number);
        }
      }
    }), params(250));
  });

  it('a unique mapping in one direction maps back to the very same object in the other', () => {
    fc.assert(fc.property(boardParts, schParts, (board, sch) => {
      const boardModel = makeBoard(board), index = buildBoardIndex(boardModel), design = makeDesign(sch), schematic = buildSchematicIndex([design]);
      for (const component of boardModel.components) {
        const forward = mapBoardSelectionToSchematic(index, schematic, { componentId: component.id });
        if (forward.status !== 'unique') continue;
        const part = forward.candidates[0];
        const sheet = schematic.sheets.get(part.documentId + '\u0000' + part.units[0].instancePath);
        expect(sheet).toBeDefined();
        const back = mapSchematicSelectionToBoard(index, schematic, { documentId: part.documentId, instancePath: part.units[0].instancePath, symbolId: part.units[0].symbolId });
        expect(back.status).toBe('unique');
        expect(back.candidates.map(c => c.componentId)).toEqual([component.id]);
      }
      // And every symbol maps to boards parts of its own name only.
      for (const [qualified, part] of schematic.partBySymbol) {
        const [documentId, rest] = qualified.split('\u0000', 2);
        const symbol = part.units[0];
        expect(symbolKey(symbol.instancePath, symbol.symbolId)).toBe(qualified.slice(documentId.length + 1));
        void rest;
        const mapped = mapSchematicSelectionToBoard(index, schematic, { documentId, instancePath: symbol.instancePath, symbolId: symbol.symbolId });
        for (const target of mapped.candidates) expect(normalizeKey(target.ref)).toBe(part.refKey);
        const boardCount = board.filter(p => normalizeKey(p.ref) === part.refKey).length, schCount = sch.filter(p => normalizeKey(p.ref) === part.refKey).length;
        expect(mapped.total).toBe(boardCount);
        expect(mapped.status).toBe(boardCount === 0 ? 'missing' : boardCount === 1 && schCount === 1 ? 'unique' : 'ambiguous');
      }
    }), params(200));
  });

  it('maps a net only to nets of exactly the same name (or a user alias), never by similarity', () => {
    fc.assert(fc.property(boardParts, schParts, (board, sch) => {
      const boardModel = makeBoard(board), index = buildBoardIndex(boardModel), design = makeDesign(sch), schematic = buildSchematicIndex([design]);
      for (const net of boardModel.nets) {
        const mapped = mapBoardNetToSchematic(index, schematic, net.name);
        const key = normalizeKey(net.name);
        for (const target of mapped.candidates) { expect(target.via).toBe('exact'); expect(schematic.netByKey.get(target.netKey)?.aliasKeys.includes(key)).toBe(true); }
        for (const twin of mapped.caseInsensitive) { expect(normalizeKey(twin.name)).not.toBe(key); expect(fold(normalizeKey(twin.name))).toBe(fold(key)); }
        if (!key) expect(mapped.status).toBe('missing');
      }
      for (const net of schematic.nets) {
        const mapped = mapSchematicNetToBoard(index, schematic, { documentId: net.documentId, netId: net.id });
        for (const target of mapped.candidates) expect(target.via).toBe('exact');
      }
    }), params(200));
  });
});

describe('search', () => {
  const query = fc.oneof(
    fc.constantFrom(...REFS, ...NETS, ' ', '', 'R', 'r1', 'ND', '3V3', 'net', 'Ｒ'),
    fc.string({ maxLength: 20 }), fc.string({ maxLength: 400 }),
  );

  it('never throws, ranks literal matches before case-insensitive ones before prefixes before substrings, and respects the limits', () => {
    fc.assert(fc.property(boardParts, schParts, query, fc.integer({ min: 0, max: 6 }), (board, sch, text, limit) => {
      const boardIndex = buildBoardIndex(makeBoard(board.map((part, i) => ({ ...part, value: i % 2 ? '10k' : 'MCU', pkg: i % 3 ? '0402' : '' })))), schematic = buildSchematicIndex([makeDesign(sch)]);
      const result = searchAll({ query: text, board: boardIndex, schematic, limits: { boardComponents: limit, boardNets: limit, schematicSymbols: limit, schematicNets: limit } });
      expect(result.query).toBe(normalizeQuery(text).slice(0, 256).trim());
      if (!result.query) { expect(result.total).toBe(0); return; }
      for (const group of result.groups) {
        expect(group.total).toBeGreaterThanOrEqual(group.rows.length);
        expect(group.truncated).toBe(group.total > group.rows.length);
      }
      const [components, nets, symbols, schNets] = result.groups;
      for (const [group, max] of [[components, limit], [nets, limit], [symbols, limit], [schNets, limit]] as const) {
        expect(group.rows.length).toBeLessThanOrEqual(max);
        const ranks = group.rows.map(row => ('match' in row ? row.match.rank : 0));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        for (const row of group.rows) if ('match' in row) {
          expect(SEARCH_TIERS[row.match.rank]).toBe(row.match.tier);
          expect(row.match.caseInsensitive).toBe(row.match.tier === 'exact-insensitive' || row.match.tier === 'prefix-insensitive');
        }
      }
      // The tier of a reference match follows from the texts alone.
      const q = result.query, qf = fold(q);
      for (const row of components.rows) if (row.match.field === 'ref') {
        const key = normalizeKey(row.ref), folded = fold(normalizeQuery(row.ref));
        const tier = key === q ? 'exact' : folded === qf ? 'exact-insensitive' : key.startsWith(q) ? 'prefix' : folded.startsWith(qf) ? 'prefix-insensitive' : 'substring';
        expect(row.match.tier).toBe(tier);
      }
    }), params(250));
  });

  it('with room for every row, a query equal to a reference returns that part first among reference matches, and the total counts every match', () => {
    fc.assert(fc.property(boardParts, fc.constantFrom(...REFS.filter(ref => normalizeKey(ref) !== '')), (board, ref) => {
      const boardIndex = buildBoardIndex(makeBoard(board));
      const result = searchAll({ query: ref, board: boardIndex, limits: { boardComponents: 50_000 } });
      const rows = result.groups[0].rows;
      expect(result.groups[0].total).toBe(rows.length);
      const exact = board.filter(part => normalizeKey(part.ref) === normalizeKey(ref)).length;
      expect(rows.filter(row => row.match.tier === 'exact')).toHaveLength(exact);
      if (exact) expect(rows[0].match.tier).toBe('exact');
      // The literal spelling comes before a spelling that only differs in case.
      const firstInsensitive = rows.findIndex(row => row.match.tier === 'exact-insensitive');
      if (firstInsensitive >= 0) for (let i = 0; i < firstInsensitive; i++) expect(rows[i].match.rank).toBeLessThanOrEqual(1);
    }), params(200));
  });
});
