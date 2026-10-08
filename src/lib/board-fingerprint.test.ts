import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_PREFIX, FINGERPRINT_VERSION, SIMILAR_THRESHOLD, UNNUMBERED_PIN_PREFIX, boardFingerprint, boardPinSet, describeBoard, diffPinSets, matchBoard, normalizePinSet, pinSetFingerprint, pinSetSimilarity, pinSetSize,
  type BoardRecord, type PinSet,
} from './board-fingerprint';
import { buildBoard, textInput } from './formats/common';
import { parseBoard } from './formats';
import type { Board } from './types';
import { expectCostAtMost } from '../test-support/timing';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A board from refs and pin numbers only; nets and coordinates are free to vary. */
function boardOf(spec: Record<string, string[]>, options: { net?: (ref: string, pin: string, index: number) => string; shift?: number; order?: 'given' | 'reversed' } = {}): Board {
  let refs = Object.keys(spec);
  if (options.order === 'reversed') refs = refs.reverse();
  const shift = options.shift ?? 0;
  const pins = refs.flatMap(ref => (options.order === 'reversed' ? [...spec[ref]].reverse() : spec[ref]).map((number, index) => ({ part: ref, number, net: options.net?.(ref, number, index) ?? '', x: shift + index, y: shift })));
  return buildBoard(textInput('', 'synthetic.board'), {
    format: 'synthetic', unitsToMm: 1,
    parts: refs.map((ref, index) => ({ key: ref, ref, side: 'top' as const, position: { x: shift + index * 10, y: 0 } })),
    pins, outline: [{ x: -5, y: -5 }, { x: 500, y: -5 }, { x: 500, y: 50 }, { x: -5, y: 50 }],
  });
}

const BASE: Record<string, string[]> = { U1: ['1', '2', '3', '4', '5', 'A1', 'B2'], R1: ['1', '2'], R2: ['1', '2'], C1: ['1', '2'], C2: ['1', '2'], TP1: ['1'], J1: ['1', '2', '3', '4'] };

describe('boardPinSet', () => {
  it('is the sorted list of references with their sorted, distinct pin numbers', () => {
    expect(boardPinSet(boardOf({ U1: ['3', '1', '2', '10'], C10: ['2', '1'], C2: ['1', '2'] }))).toEqual([['C10', ['1', '2']], ['C2', ['1', '2']], ['U1', ['1', '10', '2', '3']]]);
  });
  it('sorts by UTF-16 code unit, never by locale or numeric value', () => {
    // Upper-cased: B1, A1, Ä, Z and SS. By code unit Ä comes after Z; a locale sort would put it next to A1.
    expect(boardPinSet(boardOf({ b1: ['1'], A1: ['1'], 'ä': ['1'], Z: ['1'], 'ß': ['1'] })).map(([ref]) => ref)).toEqual(['A1', 'B1', 'SS', 'Z', 'Ä']);
  });
  it('trims, upper-cases and merges references that differ only in case or blanks', () => {
    expect(boardPinSet(boardOf({ u1: ['a1'], ' U1 ': ['b2'], 'R1': [' 1 ', '1'] }))).toEqual([['R1', ['1']], ['U1', ['A1', 'B2']]]);
  });
  it('de-duplicates pin numbers: a thermal pad drawn twice is one pin', () => {
    expect(boardPinSet(boardOf({ U1: ['1', '2', '57', '57', '57'] }))).toEqual([['U1', ['1', '2', '57']]]);
  });
  it('leaves out unnumbered pads (adapter-made ~n numbers) and the parts that only have such pads', () => {
    expect(UNNUMBERED_PIN_PREFIX).toBe('~');
    expect(boardPinSet(boardOf({ U1: ['1', '2', '~1', '~2'], FID1: ['~1'], MH1: ['~1', '~2'], R1: ['1', '2'] }))).toEqual([['R1', ['1', '2']], ['U1', ['1', '2']]]);
  });
  it('leaves out parts without pins and pins without a part', () => {
    const board = boardOf({ U1: ['1', '2'], R1: ['1', '2'] });
    const withoutPins = { components: [...board.components, { ...board.components[0], id: 'part:99', ref: 'LOGO1', pinIds: [] }], pins: [...board.pins, { ...board.pins[0], id: 'pin:99', componentId: 'part:404' }] };
    expect(boardPinSet(withoutPins)).toEqual([['R1', ['1', '2']], ['U1', ['1', '2']]]);
  });
  it('is empty for a board without numbered pins', () => {
    expect(boardPinSet({ components: [], pins: [] })).toEqual([]);
    expect(pinSetSize(boardPinSet(boardOf({ FID1: ['~1'] })))).toBe(0);
  });
  it('does not change when net names, coordinates, part order or pin order change', () => {
    const reference = boardPinSet(boardOf(BASE));
    expect(boardPinSet(boardOf(BASE, { net: (ref, pin) => `N_${ref}_${pin}`, shift: 123.4 }))).toEqual(reference);
    expect(boardPinSet(boardOf(BASE, { order: 'reversed', net: ref => (ref < 'M' ? 'GND' : '+3V3') }))).toEqual(reference);
  });
});

describe('boardFingerprint', () => {
  it('is "fp1:" and the SHA-256 of a versioned canonical text (known answers, computed independently)', async () => {
    expect(FINGERPRINT_VERSION).toBe(1);
    expect(FINGERPRINT_PREFIX).toBe('fp1:');
    const set: PinSet = [['C1', ['1', '2']], ['U1', ['1', '2', '3']]];
    expect(await pinSetFingerprint(set)).toBe('fp1:' + sha256('trace-board-fingerprint/1\n[["C1",["1","2"]],["U1",["1","2","3"]]]'));
    expect(await pinSetFingerprint(set)).toBe('fp1:74be104e644f4c48f217c6b16cb6d723b3580c3ff83218b0d924c10faddbab25');
    expect(await pinSetFingerprint([])).toBe('fp1:c711ca2a435fb115f3a308c81c2f64bdbd11e95ba88db73c7dd558b9e6976ce7');
    expect(await boardFingerprint(boardOf({ U1: ['3', '1', '2'], c1: ['2', '1'] }))).toBe('fp1:74be104e644f4c48f217c6b16cb6d723b3580c3ff83218b0d924c10faddbab25');
  });
  it('is "fp1:" and 64 lower-case hex digits, so it is never taken for a file key, which is bare hex', async () => {
    const fingerprint = await boardFingerprint(boardOf(BASE));
    expect(fingerprint).toMatch(/^fp1:[0-9a-f]{64}$/);
    expect(fingerprint).not.toMatch(/^[0-9a-f]{64}$/);
    // A record that holds a file key where a fingerprint belongs is not matched by the fingerprint of the same board.
    const open = await describeBoard(boardOf(BASE), sha256('file bytes'));
    expect(open.fileKey).not.toBe(open.fingerprint);
    expect(matchBoard({ fingerprint: sha256('file bytes') }, open)).toEqual({ kind: 'different', similarity: null });
  });
  it('is the same for the same board whatever the nets, coordinates or order', async () => {
    const reference = await boardFingerprint(boardOf(BASE));
    expect(await boardFingerprint(boardOf(BASE, { net: (ref, pin) => `Net-(${ref}-Pad${pin})`, shift: 0.5 }))).toBe(reference);
    expect(await boardFingerprint(boardOf(BASE, { order: 'reversed', shift: -77 }))).toBe(reference);
    expect(await boardFingerprint(boardOf({ ...BASE, U1: [...BASE.U1, '5', '5'], FID1: ['~1'] }))).toBe(reference);
  });
  it('changes with every difference in a reference or in a pin number', async () => {
    const reference = await boardFingerprint(boardOf(BASE));
    const variants: Array<[string, Record<string, string[]>]> = [
      ['a pin more', { ...BASE, R1: ['1', '2', '3'] }], ['a pin less', { ...BASE, R1: ['1'] }], ['a pin renumbered', { ...BASE, R1: ['1', '3'] }],
      ['a part more', { ...BASE, R3: ['1', '2'] }], ['a part less', (({ R2: _removed, ...rest }) => rest)(BASE)], ['a part renamed', Object.fromEntries(Object.entries(BASE).map(([ref, pins]) => [ref === 'R2' ? 'R22' : ref, pins]))],
      ['pins moved to another part', { ...BASE, R1: ['1'], R2: ['1', '2', '2x'] }], ['a letter in a pin number', { ...BASE, U1: ['1', '2', '3', '4', '5', 'A1', 'B3'] }],
    ];
    for (const [label, spec] of variants) {
      expect(await boardFingerprint(boardOf(spec)), label).not.toBe(reference);
    }
  });
  it('cannot be confused by names that run together', async () => {
    expect(await pinSetFingerprint([['A', ['1']], ['B', ['2']]])).not.toBe(await pinSetFingerprint([['A', ['1', 'B', '2']]]));
    expect(await pinSetFingerprint([['A', ['1,2']]])).not.toBe(await pinSetFingerprint([['A', ['1', '2']]]));
    expect(await pinSetFingerprint([['A"', ['1']]])).not.toBe(await pinSetFingerprint([['A', ['"1']]]));
  });
  it('runs where only Web Crypto exists: no DOM, no Node modules and no Buffer in the module', () => {
    const source = readFileSync(new URL('./board-fingerprint.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/\b(window|document|Buffer|require|process)\b|from 'node:|localStorage/);
    expect(source).toMatch(/crypto\?\.subtle/);
  });
});

// The same logical board written the way two exporters would write it.
interface PadSpec { number: string; net?: string; dx: number; dy: number; /** Written by KiCad only: the same number drawn twice (thermal pad). */ kicadOnly?: boolean }
interface PartSpec { ref: string; side?: 'bottom'; x: number; y: number; pads: PadSpec[]; /** A part the BVR export leaves out. */ kicadOnly?: boolean }
const PARTS: PartSpec[] = [
  { ref: 'U1', x: 30, y: 20, pads: [{ number: '1', net: 'vcc', dx: -2, dy: -1 }, { number: '2', net: 'sig', dx: -2, dy: 0 }, { number: '3', net: 'gnd', dx: -2, dy: 1 }, { number: '4', net: 'sig2', dx: 2, dy: 1 }, { number: 'A5', dx: 2, dy: 0 },
    { number: '9', net: 'gnd', dx: 0, dy: 0 }, { number: '9', net: 'gnd', dx: 0.5, dy: 0, kicadOnly: true }] },
  { ref: 'R1', x: 10, y: 10, pads: [{ number: '1', net: 'vcc', dx: -1, dy: 0 }, { number: '2', net: 'sig', dx: 1, dy: 0 }] },
  { ref: 'C1', x: 12, y: 30, pads: [{ number: '1', net: 'vcc', dx: -1, dy: 0 }, { number: '2', net: 'gnd', dx: 1, dy: 0 }] },
  { ref: 'C2', side: 'bottom', x: 40, y: 30, pads: [{ number: '1', net: 'vcc', dx: -1, dy: 0 }, { number: '2', net: 'gnd', dx: 1, dy: 0 }] },
  { ref: 'TP1', x: 50, y: 10, pads: [{ number: '1', net: 'sig', dx: 0, dy: 0 }] },
  { ref: 'J1', x: 60, y: 40, pads: [1, 2, 3, 4].map((number, index) => ({ number: String(number), net: index % 2 ? 'sig2' : 'gnd', dx: index, dy: 0 })) },
  // Pads without a number: KiCad writes an empty number, the BVR exporter an empty PIN_NUMBER and PIN_NAME. Each adapter numbers them its own way.
  { ref: 'FID1', x: 5, y: 5, pads: [{ number: '', dx: 0, dy: 0 }] },
  { ref: 'MH1', x: 95, y: 75, kicadOnly: true, pads: [{ number: '', dx: 0, dy: 0 }] },
  { ref: 'H1', x: 90, y: 10, pads: [{ number: '', dx: 0, dy: 0 }, { number: '1', net: 'gnd', dx: 2, dy: 0 }] },
];
const KICAD_NETS: Record<string, string> = { vcc: '/VCC_3V3', sig: 'Net-(R1-Pad2)', gnd: 'GND', sig2: 'Net-(U1-Pad4)' };
const BVR_NETS: Record<string, string> = { vcc: '+3V3', sig: 'N$7', gnd: 'GND', sig2: 'N$11' };

function kicadText(parts: PartSpec[], nets: Record<string, string>, shift = 0): string {
  const names = [...new Set(parts.flatMap(part => part.pads.map(pad => pad.net)).filter((key): key is string => Boolean(key)).map(key => nets[key]))];
  const table = ['(net 0 "")', ...names.map((name, index) => `(net ${index + 1} ${JSON.stringify(name)})`)].join(' ');
  const footprints = parts.map(part => {
    const layer = part.side === 'bottom' ? 'B.Cu' : 'F.Cu';
    const pads = part.pads.map(pad => `(pad ${JSON.stringify(pad.number)} smd rect (at ${pad.dx} ${pad.dy}) (size 0.8 0.8) (layers "${layer}")${pad.net ? ` (net ${names.indexOf(nets[pad.net]) + 1} ${JSON.stringify(nets[pad.net])})` : ''})`);
    return `(footprint "Lib:${part.ref}" (layer "${layer}") (at ${part.x + shift} ${part.y + shift}) (property "Reference" ${JSON.stringify(part.ref)}) (property "Value" "v") ${pads.join(' ')})`;
  });
  return `(kicad_pcb (version 20240108) (generator "synthetic") ${table}\n${footprints.join('\n')}\n(gr_rect (start 0 0) (end 100 80) (layer "Edge.Cuts")))`;
}

function bvrText(parts: PartSpec[], nets: Record<string, string>, shift = 0): string {
  const mil = (mm: number) => Math.round(mm / 0.0254);
  const rows = ['BVRAW_FORMAT_3', `OUTLINE_POINTS 0 0 ${mil(100)} 0 ${mil(100)} ${mil(80)} 0 ${mil(80)}`];
  for (const part of parts) {
    if (part.kicadOnly) continue;
    const pads = part.pads.filter(pad => !pad.kicadOnly);
    const side = part.side === 'bottom' ? 'B' : 'T';
    rows.push(`PART_NAME ${part.ref}`, `PART_SIDE ${side}`, `PART_ORIGIN ${mil(part.x + shift)} ${mil(part.y + shift)}`);
    for (const pad of pads) rows.push(`PIN_NUMBER ${pad.number}`, `PIN_NAME ${pad.number}`, `PIN_SIDE ${side}`, `PIN_ORIGIN ${mil(pad.dx)} ${mil(pad.dy)}`, 'PIN_RADIUS 16', `PIN_NET ${pad.net ? nets[pad.net] : ''}`, 'PIN_END');
    rows.push('PART_END');
  }
  return rows.join('\r\n') + '\r\n';
}

const parse = (text: string, name: string) => parseBoard({ name, data: new TextEncoder().encode(text) });

describe('the same board in two encodings', () => {
  it('KiCad and BVR3 exports that differ in net names, coordinates, units and Y direction give the same fingerprint', async () => {
    const kicad = parse(kicadText(PARTS, KICAD_NETS), 'board.kicad_pcb');
    const bvr = parse(bvrText(PARTS, BVR_NETS, 3), 'board.bvr');
    expect(kicad.format).toBe('KiCad PCB');
    expect(bvr.format).toMatch(/^BVR raw boardview/);
    // The encodings really differ: net names, pin counts (the thermal pad is drawn twice in KiCad, there are unnumbered pads) and geometry.
    expect(new Set(kicad.nets.map(net => net.name))).not.toEqual(new Set(bvr.nets.map(net => net.name)));
    expect(kicad.pins.length).toBeGreaterThan(bvr.pins.length);
    expect(kicad.bounds).not.toEqual(bvr.bounds);
    expect(kicad.components.map(part => part.ref).sort()).not.toEqual(bvr.components.map(part => part.ref).sort());
    const fingerprint = await boardFingerprint(kicad);
    expect(await boardFingerprint(bvr)).toBe(fingerprint);
    expect(boardPinSet(bvr)).toEqual(boardPinSet(kicad));
    expect(pinSetSize(boardPinSet(kicad))).toBe(18); // U1 6 (the thermal pad once), R1 2, C1 2, C2 2, TP1 1, J1 4, H1 1; no pair for the unnumbered pads of FID1, MH1 and H1
    // Both adapters mark the pads without a number as made up, with a number that starts with "~": a pad 1 of the same part (H1) keeps its own number.
    for (const board of [kicad, bvr]) {
      const generated = board.pins.filter(pin => pin.numberGenerated);
      expect(generated.length, board.format).toBeGreaterThan(0);
      for (const pin of generated) expect(pin.number.startsWith(UNNUMBERED_PIN_PREFIX), `${board.format} ${pin.number}`).toBe(true);
    }
    expect(bvr.pins.filter(pin => pin.numberGenerated).map(pin => pin.number)).toEqual(['~1', '~1']); // FID1 and H1 (the first pad of the part, ahead of its real pad 1)
    // And it is that board and no other: the same files without one pad differ.
    const fewer = PARTS.map(part => (part.ref === 'J1' ? { ...part, pads: part.pads.slice(1) } : part));
    expect(await boardFingerprint(parse(bvrText(fewer, BVR_NETS), 'board.bvr'))).not.toBe(fingerprint);
  });
  it('the same encoding moved, renamed and reordered is unchanged', async () => {
    const reference = await boardFingerprint(parse(kicadText(PARTS, KICAD_NETS), 'a.kicad_pcb'));
    const renamed = Object.fromEntries(Object.keys(KICAD_NETS).map(key => [key, `Other_${key}`]));
    expect(await boardFingerprint(parse(kicadText([...PARTS].reverse(), renamed, 17.25), 'b.kicad_pcb'))).toBe(reference);
    const reference3 = await boardFingerprint(parse(bvrText(PARTS, BVR_NETS), 'a.bvr'));
    expect(await boardFingerprint(parse(bvrText([...PARTS].reverse(), { vcc: 'V', sig: 'S', gnd: 'G', sig2: 'T' }, 40), 'b.bvr'))).toBe(reference3);
    expect(reference3).toBe(reference);
  });
  it('an unnumbered pad that an adapter numbers like a real one is a pair only that file has, so the boards match as similar', async () => {
    // What an adapter does that numbers a pad without a number like a real pad (its position in the part) and not with a ~n marker.
    const base = boardOf(BASE);
    const numbered = boardOf({ ...BASE, FID1: ['1'] });
    const [recorded, open] = [await describeBoard(base), await describeBoard(numbered)];
    expect(recorded.fingerprint).not.toBe(open.fingerprint);
    const match = matchBoard(recorded, open);
    expect(match.kind).toBe('similar');
    if (match.kind === 'similar') {
      expect(match.unmatchedRecorded).toEqual([]);
      expect(match.unmatchedOpen).toEqual([{ ref: 'FID1', pin: '1' }]);
    }
  });
});

describe('normalizePinSet', () => {
  it('canonicalizes: trims, upper-cases, merges, drops empty and unnumbered entries, sorts', () => {
    expect(normalizePinSet([['u1', ['b2', 'a1', 'A1', ' 3 ']], [' R1 ', ['2', '1']], ['U1', ['4']], ['FID1', ['~1']], ['X', []], ['', ['1']], ['C1', ['', '1']]]))
      .toEqual([['C1', ['1']], ['R1', ['1', '2']], ['U1', ['3', '4', 'A1', 'B2']]]);
  });
  it('is a fixed point of boardPinSet, so a stored set hashes like the board', async () => {
    const set = boardPinSet(boardOf(BASE));
    expect(normalizePinSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
    expect(await pinSetFingerprint(normalizePinSet(JSON.parse(JSON.stringify(set)))!)).toBe(await boardFingerprint(boardOf(BASE)));
  });
  it.each([
    ['not an array', {}], ['null', null], ['an entry that is not a pair', [['U1']]], ['a three-element entry', [['U1', ['1'], 'x']]], ['a number as reference', [[1, ['1']]]],
    ['pins that are not an array', [['U1', '1']]], ['a number as pin', [['U1', [1]]]], ['a reference over 256 characters', [['U'.repeat(257), ['1']]]], ['a pin over 256 characters', [['U1', ['1'.repeat(257)]]]],
    ['an object entry', [{ ref: 'U1', pins: ['1'] }]],
  ])('rejects %s', (_label, value) => { expect(normalizePinSet(value)).toBeNull(); });
  it('accepts the empty set and counts pairs against a limit of two million, duplicates included', () => {
    expect(normalizePinSet([])).toEqual([]);
    expect(normalizePinSet([['A', new Array<string>(2_000_000).fill('1')]])).toEqual([['A', ['1']]]);
    expect(normalizePinSet([['A', new Array<string>(2_000_001).fill('1')]])).toBeNull();
    expect(normalizePinSet([['A', new Array<string>(1_000_000).fill('1')], ['B', new Array<string>(1_000_001).fill('1')]])).toBeNull();
  });
  it('keeps hostile reference names as plain data', () => {
    const set = normalizePinSet(JSON.parse('[["__proto__", ["1"]], ["constructor", ["2"]], ["toString", ["3"]]]'));
    expect(set).toEqual([['CONSTRUCTOR', ['2']], ['TOSTRING', ['3']], ['__PROTO__', ['1']]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('pinSetSimilarity and diffPinSets', () => {
  const flat = (set: PinSet) => new Set(set.flatMap(([ref, pins]) => pins.map(pin => `${ref}\u0000${pin}`)));
  it('is the Jaccard similarity of the (ref, pin) pairs', () => {
    const a = normalizePinSet([['U1', ['1', '2', '3']], ['R1', ['1', '2']]])!;
    const b = normalizePinSet([['U1', ['1', '2', '4']], ['R1', ['1', '2']], ['C1', ['1']]])!;
    expect(pinSetSimilarity(a, a)).toBe(1);
    expect(pinSetSimilarity(a, b)).toBe(4 / 7);
    expect(pinSetSimilarity(b, a)).toBe(4 / 7);
    expect(pinSetSimilarity(a, [])).toBe(0);
    expect(pinSetSimilarity([], [])).toBe(1);
    expect(diffPinSets(a, b)).toEqual({ shared: 4, similarity: 4 / 7, onlyA: [{ ref: 'U1', pin: '3' }], onlyB: [{ ref: 'C1', pin: '1' }, { ref: 'U1', pin: '4' }] });
  });
  it('agrees with a brute-force computation on random sets', () => {
    let seed = 0x9e3779b9;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const randomSet = () => normalizePinSet(Array.from({ length: Math.floor(random() * 7) }, () => ['R' + Math.floor(random() * 6), Array.from({ length: Math.floor(random() * 6) }, () => String(Math.floor(random() * 8)))]))!;
    for (let round = 0; round < 500; round++) {
      const a = randomSet(), b = randomSet(), fa = flat(a), fb = flat(b);
      const shared = [...fa].filter(key => fb.has(key)).length, union = new Set([...fa, ...fb]).size;
      expect(pinSetSimilarity(a, b)).toBe(union === 0 ? 1 : shared / union);
      const difference = diffPinSets(a, b);
      expect(difference.shared).toBe(shared);
      const key = (pair: { ref: string; pin: string }) => `${pair.ref}\u0000${pair.pin}`;
      expect(new Set(difference.onlyA.map(key))).toEqual(new Set([...fa].filter(pair => !fb.has(pair))));
      expect(new Set(difference.onlyB.map(key))).toEqual(new Set([...fb].filter(pair => !fa.has(pair))));
      expect(difference.onlyA.length + difference.shared).toBe(fa.size);
      expect(difference.onlyB.length + difference.shared).toBe(fb.size);
      expect(difference.onlyA.map(key)).toEqual([...difference.onlyA.map(key)].sort());
    }
  });
});

describe('matchBoard', () => {
  const spec = (count: number): Record<string, string[]> => ({ U1: Array.from({ length: count }, (_, index) => String(index + 1)) });
  const record = (board: Board, fileKey?: string) => describeBoard(board, fileKey);
  it('describes a board by file key, fingerprint and pin set', async () => {
    const description = await record(boardOf(BASE), 'abc123');
    expect(description).toEqual({ fileKey: 'abc123', fingerprint: await boardFingerprint(boardOf(BASE)), pinSet: boardPinSet(boardOf(BASE)) });
    expect('fileKey' in (await record(boardOf(BASE)))).toBe(false);
  });
  it('1. same file: equal file keys, whatever the fingerprints say', async () => {
    const recorded = await record(boardOf(BASE), 'key');
    expect(matchBoard(recorded, await record(boardOf(BASE), 'key'))).toEqual({ kind: 'same-file' });
    expect(matchBoard(recorded, await record(boardOf({ R1: ['1', '2'] }), 'key'))).toEqual({ kind: 'same-file' });
    expect(matchBoard({ fileKey: 'key', fingerprint: 'x' }, { fileKey: 'key', fingerprint: 'y' })).toEqual({ kind: 'same-file' });
  });
  it('a file key on one side only, or different keys, is no file match', async () => {
    const recorded = await record(boardOf(BASE), 'one');
    expect(matchBoard(recorded, await record(boardOf(BASE))).kind).toBe('same-fingerprint');
    expect(matchBoard(recorded, await record(boardOf(BASE), 'two')).kind).toBe('same-fingerprint');
    expect(matchBoard({ fingerprint: recorded.fingerprint }, await record(boardOf(BASE), 'two')).kind).toBe('same-fingerprint');
    expect(matchBoard({ fileKey: '', fingerprint: recorded.fingerprint }, { fileKey: '', fingerprint: recorded.fingerprint }).kind).toBe('same-fingerprint');
  });
  it('2. same fingerprint: the same board from another file, with or without the stored pin set', async () => {
    const recorded = await record(boardOf(BASE, { net: ref => ref }), 'old');
    const open = await record(boardOf(BASE, { order: 'reversed', shift: 9 }), 'new');
    expect(matchBoard(recorded, open)).toEqual({ kind: 'same-fingerprint' });
    expect(matchBoard({ fingerprint: recorded.fingerprint }, open)).toEqual({ kind: 'same-fingerprint' });
    expect(matchBoard({ fingerprint: recorded.fingerprint }, { fingerprint: open.fingerprint })).toEqual({ kind: 'same-fingerprint' });
  });
  it('3. similar from 0.95 up, with the pairs that exist on one side only', async () => {
    const recorded = await record(boardOf(spec(20)), 'old');
    const missing = await record(boardOf(spec(19)), 'new'); // 19 of 20: exactly 0.95
    const match = matchBoard(recorded, missing);
    expect(match).toEqual({ kind: 'similar', similarity: 0.95, unmatchedRecorded: [{ ref: 'U1', pin: '20' }], unmatchedOpen: [] });
    const both = await record(boardOf({ ...spec(19), U2: ['1'] }), 'new'); // 19 shared, 1 each way: 19/21
    expect(matchBoard(recorded, both).kind).toBe('different');
    const extra = await record(boardOf({ ...spec(20), R1: ['1'] }), 'new'); // 20 of 21
    const similar = matchBoard(recorded, extra);
    expect(similar.kind).toBe('similar');
    if (similar.kind === 'similar') {
      expect(similar.similarity).toBe(20 / 21);
      expect(similar.unmatchedRecorded).toEqual([]);
      expect(similar.unmatchedOpen).toEqual([{ ref: 'R1', pin: '1' }]);
    }
  });
  it('4. different below the threshold, with the similarity that was measured', async () => {
    const recorded = await record(boardOf(spec(20)));
    expect(matchBoard(recorded, await record(boardOf(spec(18))))).toEqual({ kind: 'different', similarity: 0.9 });
    expect(matchBoard(recorded, await record(boardOf({ R1: ['1', '2'] })))).toEqual({ kind: 'different', similarity: 0 });
  });
  it('takes the threshold as a parameter', async () => {
    const recorded = await record(boardOf(spec(20)));
    const open = await record(boardOf(spec(18)));
    expect(SIMILAR_THRESHOLD).toBe(0.95);
    expect(matchBoard(recorded, open).kind).toBe('different');
    expect(matchBoard(recorded, open, 0.9).kind).toBe('similar');
    expect(matchBoard(recorded, open, 0.91).kind).toBe('different');
  });
  it('a record that kept only its fingerprint can match as the same board and nothing else', async () => {
    const open = await record(boardOf(spec(20)));
    const lean: BoardRecord = { fingerprint: (await record(boardOf(spec(19)))).fingerprint };
    expect(matchBoard(lean, open)).toEqual({ kind: 'different', similarity: null });
    expect(matchBoard({ fingerprint: open.fingerprint }, { fingerprint: 'other' })).toEqual({ kind: 'different', similarity: null });
  });
  it('an open board without numbered pins matches only by file key', async () => {
    const empty = await record(boardOf({ FID1: ['~1'] }), 'k1');
    expect(matchBoard(await record(boardOf({ MH1: ['~1'] }), 'k2'), empty)).toEqual({ kind: 'different', similarity: null });
    expect(matchBoard({ fileKey: 'k1', fingerprint: empty.fingerprint }, empty)).toEqual({ kind: 'same-file' });
    expect(matchBoard(await record(boardOf(spec(3))), empty)).toEqual({ kind: 'different', similarity: null });
  });
  it('a recorded set without numbered pins is never offered as similar', async () => {
    const empty: BoardRecord = { fingerprint: 'e', pinSet: [] };
    expect(matchBoard(empty, await record(boardOf(spec(3))), 0)).toEqual({ kind: 'different', similarity: 0 });
  });
});

describe('board size', () => {
  /** `parts` parts with 5 pins each (50,000 parts are 250,000 pins), without going through the format adapters. */
  const bigBoard = (parts: number, rotate = 0): Pick<Board, 'components' | 'pins'> => {
    const components = [] as unknown as Board['components'], pins = [] as unknown as Board['pins'];
    for (let part = 0; part < parts; part++) {
      const id = `part:${part}`;
      components.push({ id, ref: `U${(part + rotate) % parts}`, pinIds: [] } as unknown as Board['components'][number]);
      for (let pin = 1; pin <= 5; pin++) pins.push({ id: `pin:${part}:${pin}`, componentId: id, number: String(pin) } as unknown as Board['pins'][number]);
    }
    return { components, pins };
  };
  /** The first four fifths of a board: 40,000 of 50,000 parts with their pins. */
  const fourFifths = (board: Pick<Board, 'components' | 'pins'>) => ({ components: board.components.slice(0, board.components.length / 5 * 4), pins: board.pins.slice(0, board.pins.length / 5 * 4) });
  it('fingerprints 250,000 pins, and matches two such boards, in linear time', async () => {
    // Tables and sorted lists of 50,000 parts fall out of the processor caches, so the time over the size does not tell linear from quadratic cleanly; each step is compared with a plain pass over
    // the same data instead. A pass over the pins costs about 1.5 ms: building the set (hash tables, sorting) about 50 to 100 times that, the similarity walk 2 to 12 times a pass over the two sets,
    // matching two equal fingerprints about once a pass over a set. A lookup that scans the parts for every pin, or a walk that restarts per reference, costs thousands of passes.
    const board = bigBoard(50_000), shuffled = bigBoard(50_000, 7), four = fourFifths(board);
    const recorded = await describeBoard(board, 'a'), open = await describeBoard(shuffled, 'b'), other = boardPinSet(four);
    expect(pinSetSize(recorded.pinSet)).toBe(250_000);
    const pass = () => { let total = 0; for (const pin of board.pins) total += pin.number.length + pin.componentId.length; return total; };
    expectCostAtMost('the pin set of 250,000 pins', () => boardPinSet(board), pass, 400);
    expectCostAtMost('the similarity of two pin sets', () => pinSetSimilarity(recorded.pinSet, other), () => pinSetSize(recorded.pinSet) + pinSetSize(other), 40);
    expectCostAtMost('matching two boards by their fingerprints', () => matchBoard(recorded, open), () => pinSetSize(recorded.pinSet), 4);
    expect(matchBoard(recorded, open)).toEqual({ kind: 'same-fingerprint' });
    expect(pinSetSimilarity(recorded.pinSet, other)).toBe(0.8);
  });
});
