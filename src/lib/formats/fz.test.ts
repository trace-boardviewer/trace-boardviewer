import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { fzKeyParityValid, rc6Feedback } from './crypto';
import { parseFz, parseFzContent } from './fz';

const encode = (text: string) => new TextEncoder().encode(text);
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** A deterministic 44-word key whose per-word parity satisfies the upstream FZ or CAE table (the real vendor keys are not shipped). */
function parityKey(seed: number, variant: 'fz' | 'cae' = 'fz'): number[] {
  const table = variant === 'cae'
    ? [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0]
    : [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
  const key = Array.from({ length: 44 }, (_, index) => {
    const word = (Math.imul(seed + index, 0x9e3779b1) ^ (seed * 7919)) >>> 0;
    const even = (word.toString(2).match(/1/g)?.length ?? 0) % 2 === 0 ? 1 : 0;
    return even === table[index] ? word : (word ^ 1) >>> 0; // flipping the low bit toggles the word's parity
  });
  if (!fzKeyParityValid(key, variant)) throw new Error('test key construction failed');
  return key;
}

const CONTENT = `UNIT:thou
A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!
S!U1!!SOIC8!NO!0!
S!R1!!RES0402!YES!90!
A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!
S!GND!U1!1!VSS!1000!2000!!6!
S!VCC!U1!2!VDD!1000,5!2100!1!!
S!SIG!R1!0!A1!500!-250.25!!7.5!
S!!R1!2!!600!-250.25!!!
A!TESTVIA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!X!Y!LOC!RADIUS!
S!Y!GND!U1!1!VSS!1500!2500!T!10!
S!Y!SIG!R1!1!A1!1600!2600!B!!
A!GRAPHIC_DATA_NAME!GRAPHIC_DATA_NUMBER!
S!LINE!1!ignored!
`;
const DESCRIPTION = 'Synthetic board\nPARTNO\tDESCRIPTION\tQTY\tLOCATIONS\tPARTNO2\n0001\tIC SOIC8 THING\t1\tU1\t\nsSKIP\tnot used\t1\tR1\t\n0002\tRES 10K\t1\tR1 R9\t\n';

interface Layout { prefixed?: boolean; footerPlus8?: boolean }
/** `[u32 contentLength][content zlib][u32 descriptionLength]?[description zlib][u32 footer]` in all four accepted spellings. */
function container(content = CONTENT, description = DESCRIPTION, { prefixed = true, footerPlus8 = false }: Layout = {}, compressed?: { content?: Uint8Array; description?: Uint8Array }): Uint8Array {
  const c = compressed?.content ?? zlibSync(encode(content)), d = compressed?.description ?? zlibSync(encode(description));
  return Uint8Array.from([...u32(c.length), ...c, ...(prefixed ? u32(d.length) : []), ...d, ...u32(d.length + (footerPlus8 ? 8 : 0))]);
}
const KEY = parityKey(11), OTHER_KEY = parityKey(12), CAE_KEY = parityKey(13, 'cae');
const encrypted = (data = container(), key = KEY) => rc6Feedback(data, key, true);
const parse = (data: Uint8Array, name = 'board.fz', options?: { fzKey?: number[] }) => parseFz({ name, data, ...(options ? { options } : {}) });
function error(run: () => unknown): BoardFormatError {
  try { run(); } catch (caught) { if (caught instanceof BoardFormatError) return caught; throw caught; }
  throw new Error('expected a BoardFormatError');
}

describe('parseFz', () => {
  it('round-trips an RC6-encrypted container with exact mil geometry, sides, nets, pin names and descriptions', () => {
    const board = parse(encrypted(), 'demo/board.fz', { fzKey: KEY });
    expect(board).not.toBeNull();
    expect(board!.format).toBe('FZ (RC6)'); expect(board!.name).toBe('board');
    expect(board!.components.map(part => [part.ref, part.side, part.package, part.value])).toEqual([
      ['U1', 'top', 'SOIC8', 'IC SOIC8 THING'], ['R1', 'bottom', 'RES0402', 'RES 10K'], ['TP:1', 'top', 'TESTVIA', ''], ['TP:2', 'bottom', 'TESTVIA', ''],
    ]);
    const [u1, r1, tp1, tp2] = board!.components;
    const pins = board!.pins;
    expect(pins).toHaveLength(6);
    expect(pins[0]).toMatchObject({ componentId: u1.id, number: '1', name: 'VSS', net: 'GND', side: 'top', x: 25.4, y: 50.8, radius: 6 * 0.0254 });
    expect(pins[1]).toMatchObject({ componentId: u1.id, number: '2', name: 'VDD', net: 'VCC', radius: 0 });
    expect(pins[1].x).toBeCloseTo(1000.5 * 0.0254, 12); expect(pins[1].y).toBeCloseTo(2100 * 0.0254, 12);
    expect(pins[2]).toMatchObject({ componentId: r1.id, number: 'A1', name: 'A1', net: 'SIG', side: 'bottom', x: 12.7, radius: 7.5 * 0.0254 });
    expect(pins[2].y).toBeCloseTo(-250.25 * 0.0254, 12);
    expect(pins[3]).toMatchObject({ componentId: r1.id, number: '2', name: '2', net: '', radius: 0 });
    expect(pins[4]).toMatchObject({ componentId: tp1.id, number: '1', name: 'VSS', net: 'GND', side: 'top', x: 1500 * 0.0254, y: 2500 * 0.0254, radius: 10 * 0.0254 });
    expect(pins[5]).toMatchObject({ componentId: tp2.id, number: '1', name: 'A1', net: 'SIG', side: 'bottom', radius: 0 });
    expect(board!.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 2], ['VCC', 1], ['SIG', 2]]);
    expect(board!.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
    expect(board!.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 3 } });
    expect(board!.warnings.filter(w => w.key === 'parse.warning.formatNote')).toHaveLength(1);
  });

  it('treats UNIT:millimeters as real millimetres (not upstream\'s 25.4 multiplier) and defaults to thou', () => {
    const mm = parse(encrypted(container(CONTENT.replace('UNIT:thou', 'UNIT:millimeters'))), 'b.fz', { fzKey: KEY })!;
    expect(mm.pins[0]).toMatchObject({ x: 1000, y: 2000, radius: 6 });
    const mil = parse(encrypted(container(CONTENT.replace('UNIT:thou\n', ''))), 'b.fz', { fzKey: KEY })!;
    expect(mil.pins[0]).toMatchObject({ x: 25.4, y: 50.8 });
  });

  it('discloses a unit line it does not know instead of silently assuming thou, and accepts the thou spellings quietly', () => {
    const notes = (unit: string) => parse(encrypted(container(CONTENT.replace('UNIT:thou', unit))), 'b.fz', { fzKey: KEY })!.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
    expect(notes('UNIT:inches')).toContain('FZ (RC6): unrecognized unit line "UNIT:inches"; coordinates are read as thou (0.001 inch).');
    expect(notes('UNIT:mils')).toHaveLength(1); expect(notes('UNIT:Thou')).toHaveLength(1); // only the RADIUS note
    const upper = parse(encrypted(container(CONTENT.replace('UNIT:thou', 'UNIT:Millimeters'))), 'b.fz', { fzKey: KEY })!;
    expect(upper.pins[0]).toMatchObject({ x: 1000, y: 2000 });
  });

  it.each([
    ['prefixed, footer = blob length', { prefixed: true, footerPlus8: false }],
    ['prefixed, footer = blob + 8 (FZFile::split arithmetic)', { prefixed: true, footerPlus8: true }],
    ['unprefixed, footer = blob length', { prefixed: false, footerPlus8: false }],
    ['unprefixed, footer = blob + 8', { prefixed: false, footerPlus8: true }],
  ])('accepts the %s container layout, encrypted and unencrypted', (_label, layout: Layout) => {
    const plain = container(CONTENT, DESCRIPTION, layout);
    for (const board of [parse(plain), parse(encrypted(plain), 'x.fz', { fzKey: KEY })]) {
      expect(board!.components).toHaveLength(4); expect(board!.pins).toHaveLength(6);
      expect(board!.components[0].value).toBe('IC SOIC8 THING');
    }
  });

  it('parses the already decoded content text and CAE with its own key parity', () => {
    const text = parse(encode(CONTENT), 'plain.fz')!;
    expect(text.components).toHaveLength(4); expect(text.components[0].value).toBe('');
    const cae = parse(encrypted(container(), CAE_KEY), 'asrock.cae', { fzKey: CAE_KEY })!;
    expect(cae.format).toBe('CAE'); expect(cae.pins).toHaveLength(6);
    const wrongTable = error(() => parse(encrypted(container(), KEY), 'asrock.cae', { fzKey: KEY }));
    expect(wrongTable.code).toBe('INVALID_KEY'); expect(wrongTable.message).toMatch(/CAE key parity/);
  });

  it('returns null for other extensions and for text that is not FZ content', () => {
    expect(parse(encrypted(), 'board.brd', { fzKey: KEY })).toBeNull();
    expect(parse(encode('$HEADER\nGENCAD 1.4\n'), 'renamed.fz')).toBeNull();
    expect(parse(encode('(kicad_pcb (version 3))'), 'renamed.cae')).toBeNull();
  });

  it('demands the key only for encrypted data and reports mistyped keys before decrypting', () => {
    const missing = error(() => parse(encrypted()));
    expect(missing).toMatchObject({ code: 'KEY_REQUIRED', format: 'FZ/CAE', keyKind: 'fz' });
    expect(missing.message).toMatch(/44 32-bit words/);
    expect(error(() => parse(encrypted(), 'b.fz', { fzKey: KEY.slice(0, 43) })).code).toBe('INVALID_KEY');
    expect(error(() => parse(encrypted(), 'b.fz', { fzKey: [...KEY.slice(0, 43), -5] })).code).toBe('INVALID_KEY');
    const parity = error(() => parse(encrypted(), 'b.fz', { fzKey: KEY.map((word, index) => index === 3 ? (word ^ 0x10) >>> 0 : word) }));
    expect(parity.code).toBe('INVALID_KEY'); expect(parity.message).toMatch(/parity/);
    expect(parse(container(), 'b.fz', { fzKey: OTHER_KEY })!.pins).toHaveLength(6); // unencrypted: key is ignored
  });

  it('turns a wrong key into a clean INVALID_KEY error, never a bounds exception', () => {
    const wrong = error(() => parse(encrypted(), 'b.fz', { fzKey: OTHER_KEY }));
    expect(wrong.code).toBe('INVALID_KEY'); expect(wrong.message).toMatch(/check the key/);
    for (const length of [20, 21, 64, 1000]) {
      const junk = Uint8Array.from({ length }, (_, index) => (index * 131 + 7) & 255);
      expect(error(() => parse(junk, 'b.fz', { fzKey: KEY })).code).toMatch(/^(INVALID_KEY|INVALID_FORMAT)$/);
    }
  });

  it('rejects truncated and inconsistent containers', () => {
    const plain = container();
    expect(error(() => parse(plain.subarray(0, plain.length - 1))).message).toMatch(/inconsistent/);
    expect(error(() => parse(plain.subarray(0, 17), 'b.fz')).message).toMatch(/too short/);
    const truncatedEncrypted = error(() => parse(encrypted().subarray(0, 40), 'b.fz', { fzKey: KEY }));
    expect(truncatedEncrypted.code).toBe('INVALID_KEY');
    const c = zlibSync(encode(CONTENT)), d = zlibSync(encode(DESCRIPTION));
    const footerPlus4 = Uint8Array.from([...u32(c.length), ...c, ...u32(d.length), ...d, ...u32(d.length + 4)]);
    expect(error(() => parse(footerPlus4)).message).toMatch(/inconsistent/);
    const prefixMismatch = Uint8Array.from([...u32(c.length), ...c, ...u32(d.length + 1), ...d, ...u32(d.length)]);
    expect(error(() => parse(prefixMismatch)).message).toMatch(/inconsistent/);
    const descriptionTooLong = Uint8Array.from([...u32(c.length), ...c, ...u32(0xffff), ...d, ...u32(0xffff)]);
    expect(error(() => parse(descriptionTooLong)).message).toMatch(/inconsistent/);
    const contentTooLong = Uint8Array.from([...u32(0xfffffff0), ...c, ...u32(d.length), ...d, ...u32(d.length)]);
    expect(error(() => parse(contentTooLong, 'b.fz', { fzKey: KEY })).code).toBe('INVALID_KEY');
    expect(error(() => parse(contentTooLong)).code).toBe('KEY_REQUIRED'); // an implausible prefix cannot be told from ciphertext
    const noDescription = Uint8Array.from([...u32(c.length), ...c, ...u32(0)]);
    expect(error(() => parse(noDescription)).message).toMatch(/inconsistent/);
  });

  it('surfaces corrupt compressed data and the inflated-size cap', () => {
    const c = zlibSync(encode(CONTENT)); c[10] ^= 0xff;
    const corrupt = error(() => parse(container(CONTENT, DESCRIPTION, {}, { content: c })));
    expect(corrupt.code).toBe('INVALID_FORMAT'); expect(corrupt.message).toMatch(/unencrypted container/);
    const corruptEncrypted = error(() => parse(encrypted(container(CONTENT, DESCRIPTION, {}, { content: c })), 'b.fz', { fzKey: KEY }));
    expect(corruptEncrypted.code).toBe('INVALID_KEY');
    const huge = zlibSync(new Uint8Array(16 * 1024 * 1024 + 1), { level: 1 });
    const capped = error(() => parse(encrypted(container(CONTENT, DESCRIPTION, {}, { description: huge })), 'b.fz', { fzKey: KEY }));
    expect(capped.code).toBe('LIMIT_EXCEEDED');
    expect(error(() => parse(new Uint8Array(64 * 1024 * 1024 + 1), 'b.fz')).code).toBe('LIMIT_EXCEEDED');
  });

  it('B06: UNCONNECTED<n> sentinels are "no net" on pins and test vias (never a false shared net); look-alike names stay', () => {
    const content = 'A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!\nS!UNCONNECTED12!U1!1!!1!1!!!\nS!UNCONNECTED12!U1!2!!2!1!!!\n'
      + 'S!UNCONNECTEDX!U1!3!!3!1!!!\nS!unconnected_7!U1!4!!4!1!!!\nS!UNCONNECTED<9>!U1!5!!5!1!!!\nS!NC!U1!6!!6!1!!!\nA!TESTVIA!\nS!Y!UNCONNECTED7!U1!1!!5!5!T!!\nS!Y!GND!U1!2!!6!5!B!!\n';
    const raw = parseFzContent(content, undefined, 'FZ (RC6)');
    expect(raw.pins.map(pin => pin.net)).toEqual([undefined, undefined, 'UNCONNECTEDX', undefined, undefined, 'NC', undefined, 'GND']);
    const board = parse(encode(content), 'x.fz')!;
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['UNCONNECTEDX', 1], ['NC', 1], ['GND', 1]]);
    expect(board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => w.params?.message)).toContain('5 pins marked UNCONNECTED by the exporter are shown without a net.');
    const encryptedBoard = parse(encrypted(container(content)), 'x.fz', { fzKey: KEY })!;
    expect(encryptedBoard.nets.map(net => net.name)).toEqual(['UNCONNECTEDX', 'NC', 'GND']);
  });

  it('B39: generated test-via parts live in their own key namespace, so a source REFDES such as nail:1 cannot collide', () => {
    const content = (ref: string) => `A!REFDES!\nS!${ref}!!!NO!0!\nA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!\nS!GND!${ref}!1!!1!1!!!\nA!TESTVIA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!X!Y!LOC!RADIUS!\nS!Y!VCC!${ref}!1!!5!5!T!!\n`;
    for (const ref of ['nail:2', 'nail:1', 'TP:1', 'nail:0']) {
      const board = parse(encode(content(ref)), 'x.fz')!;
      expect(board.components.map(part => part.ref), ref).toEqual([ref, 'TP:1']);
      expect(board.pins.map(pin => [pin.componentId, pin.net]), ref).toEqual([[board.components[0].id, 'GND'], [board.components[1].id, 'VCC']]);
      expect(board.nets.map(net => net.name)).toEqual(['GND', 'VCC']);
    }
    const two = `${content('nail:1')}S!Y!SIG!nail:1!2!!6!6!B!!\n`;
    const board = parse(encode(two), 'x.fz')!;
    expect(board.components.map(part => part.ref)).toEqual(['nail:1', 'TP:1', 'TP:2']);
    expect(board.pins.map(pin => pin.componentId)).toEqual([board.components[0].id, board.components[1].id, board.components[2].id]);
  });

  it('B16: absurd, non-finite, hex or out-of-range numbers are a BoardFormatError (the ±1e9 mm cap applies after unit scaling)', () => {
    const board = (x: string, unit = 'UNIT:thou') => `${unit}\nA!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!\nS!N!U1!1!!${x}!2!!!\n`;
    for (const bad of ['1e30', '1e999', '-1e30', 'NaN', 'Infinity', '0x10', '1e', '--5', '1 2']) {
      expect(() => parse(encode(board(bad)), 'x.fz'), bad).toThrow(BoardFormatError);
    }
    expect(() => parse(encode(board('1e30')), 'x.fz')).toThrow(/exceeds the supported range/);
    expect(() => parse(encode(board('1e10', 'UNIT:millimeters')), 'x.fz')).toThrow(/exceeds the supported range/);
    expect(parse(encode(board('1e9', 'UNIT:millimeters')), 'x.fz')!.pins[0].x).toBe(1e9);
    expect(parse(encode(board('1e-3')), 'x.fz')!.pins[0].x).toBeCloseTo(1e-3 * 0.0254, 15);
    expect(() => parse(encode(board('1').replace('!!!\n', '!!1e30!\n')), 'x.fz')).toThrow(/exceeds the supported range/); // pin radius
  });

  it('bounds record counts while reading (LIMIT_EXCEEDED, not an unbounded allocation)', { timeout: 120_000 }, () => {
    let rows = 'A!REFDES!\n';
    for (let index = 0; index <= 250_000; index++) rows += `S!R${index}!!!NO!0!\n`;
    expect(error(() => parse(encode(rows), 'x.fz')).code).toBe('LIMIT_EXCEEDED');
    let nets = 'A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\n';
    for (let index = 0; index <= 1_000_000; index++) nets += 'S!N!U1!1!!1!1!!!\n';
    expect(error(() => parse(encode(nets), 'x.fz')).code).toBe('LIMIT_EXCEEDED');
  });

  it('carries keyKind only on key errors: structural failures never ask the UI for a key', () => {
    const structural = error(() => parse(container().subarray(0, container().length - 1)));
    expect(structural).toMatchObject({ code: 'INVALID_FORMAT', format: 'FZ/CAE' }); expect(structural.keyKind).toBeUndefined();
    const corrupt = zlibSync(encode(CONTENT)); corrupt[10] ^= 0xff;
    expect(error(() => parse(container(CONTENT, DESCRIPTION, {}, { content: corrupt }))).keyKind).toBeUndefined();
    for (const failure of [error(() => parse(encrypted())), error(() => parse(encrypted(), 'b.fz', { fzKey: OTHER_KEY })), error(() => parse(encrypted(), 'b.fz', { fzKey: KEY.slice(1) })), error(() => parse(encrypted(), 'a.cae', { fzKey: KEY }))]) {
      expect(['KEY_REQUIRED', 'INVALID_KEY']).toContain(failure.code);
      expect(failure).toMatchObject({ format: 'FZ/CAE', keyKind: 'fz', name: 'BoardFormatError' });
    }
  });

  it('validates the decoded content strictly', () => {
    const raw = (content: string) => parseFzContent(content, undefined, 'FZ (RC6)');
    expect(() => raw('S!U1!!!NO!0!\n')).toThrow(/no A! block/);
    expect(() => raw('A!REFDES!\nS!U1!!!NO!0!\nS!U1!!!NO!0!\n')).toThrow(/duplicate REFDES U1 on line 3/);
    expect(() => raw('A!REFDES!\nS!!!!NO!0!\n')).toThrow(/empty REFDES on line 2/);
    expect(() => raw('A!NET_NAME!\nS!GND!U9!1!!1!2!!!\n')).toThrow(/unknown component U9/);
    expect(() => raw('A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\nS!GND!U1!1!!abc!2!!!\n')).toThrow(/invalid pin X on line 4: abc/);
    expect(() => raw('A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\nS!GND!U1!1!!1!!!!\n')).toThrow(/invalid pin Y on line 4: \(empty\)/);
    expect(() => raw('A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\nS!GND!U1!1!!1!2!!-1!\n')).toThrow(/negative pin radius/);
    expect(() => raw('A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\nS!GND!U1!!!1!2!!!\n')).toThrow(/pin without number/);
    const board = raw('A!REFDES!\nS!U1!!!NO!0!\nA!NET_NAME!\nS!GND!U1!0!!1!2!!!\n');
    expect(board.pins[0]).toMatchObject({ number: '0', name: '0', x: 1, y: 2 });
    expect(board.unitsToMm).toBe(0.0254); expect(board.warnings).toEqual([]);
  });

  it('B16/BOM: undecodable inflated text is a format error (INVALID_KEY under a key), never a TypeError', () => {
    const bomGarbage = zlibSync(Uint8Array.from([0xff, 0xfe, 0x41, 0xd8]));
    const plain = container(CONTENT, DESCRIPTION, {}, { content: bomGarbage });
    expect(error(() => parse(plain)).code).toBe('INVALID_FORMAT');
    expect(error(() => parse(encrypted(plain), 'b.fz', { fzKey: KEY })).code).toBe('INVALID_KEY');
  });

  it('rejects a wrong key from the first block header, before decrypting the rest of a large file', { timeout: 60_000 }, () => {
    // 16 MiB of ciphertext-like bytes: a full decrypt costs several seconds, the header check microseconds.
    const big = new Uint8Array(16 * 1024 * 1024).map((_, index) => index * 31 + 5 & 255);
    const started = performance.now();
    const failure = error(() => parse(big, 'big.fz', { fzKey: KEY }));
    expect(failure.code).toBe('INVALID_KEY');
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('treats short random ciphertext as encrypted rather than text, for every key', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const junk = Uint8Array.from({ length: 24 + seed % 40 }, (_, index) => (index * 131 + seed * 17) * 7 >>> 3 & 255);
      const failure = error(() => parse(junk, 'b.fz'));
      expect(['KEY_REQUIRED', 'INVALID_FORMAT'], `seed ${seed}`).toContain(failure.code);
    }
  });

  it('CAE: the same encrypt-then-parse workflow with its own parity table and keyKind', () => {
    const data = encrypted(container(), CAE_KEY);
    expect(error(() => parse(data, 'x.cae'))).toMatchObject({ code: 'KEY_REQUIRED', format: 'FZ/CAE', keyKind: 'fz' });
    expect(error(() => parse(data, 'x.cae', { fzKey: parityKey(14, 'cae') }))).toMatchObject({ code: 'INVALID_KEY', keyKind: 'fz' });
    const board = parse(data, 'x.cae', { fzKey: CAE_KEY })!;
    expect(board.format).toBe('CAE'); expect(board.pins).toHaveLength(6);
    expect(error(() => parse(data, 'x.fz', { fzKey: CAE_KEY }))).toMatchObject({ code: 'INVALID_KEY', keyKind: 'fz' }); // an FZ-named file needs a key with the FZ parity pattern
  });
});

describe('parseFz malformed input', () => {
  const plain = container();
  const cipher = encrypted(plain);
  /** Below the 20-byte minimum container a printable fragment is plain text of another format (null); everything longer must fail loudly. */
  const prefixOutcome = (data: Uint8Array, length: number, options?: { fzKey: number[] }) => {
    try { return parse(data.subarray(0, length), 'b.fz', options) === null && length < 20 ? 'null' : 'board'; } catch (caught) { return caught instanceof BoardFormatError ? 'error' : String(caught); }
  };
  it('every strict prefix of an unencrypted container is a BoardFormatError', () => {
    expect(parse(plain)).not.toBeNull();
    for (let length = 0; length < plain.length; length++) expect(['error', 'null'], `length ${length}`).toContain(prefixOutcome(plain, length));
    for (let length = 20; length < plain.length; length++) expect(prefixOutcome(plain, length), `length ${length}`).toBe('error');
  });
  it('every strict prefix of an encrypted container, with the right key, is a BoardFormatError', () => {
    expect(parse(cipher, 'b.fz', { fzKey: KEY })).not.toBeNull();
    for (let length = 0; length < cipher.length; length++) expect(['error', 'null'], `length ${length}`).toContain(prefixOutcome(cipher, length, { fzKey: KEY }));
    for (let length = 20; length < cipher.length; length++) expect(prefixOutcome(cipher, length, { fzKey: KEY }), `length ${length}`).toBe('error');
  });
  it('every single-byte corruption of either container is a board or a BoardFormatError', () => {
    for (let index = 0; index < plain.length; index++) {
      for (const [data, options] of [[plain, undefined], [cipher, { fzKey: KEY }]] as const) {
        const damaged = Uint8Array.from(data); damaged[index] ^= 0x5a;
        try { parse(damaged, 'b.fz', options); } catch (caught) { expect(caught, `byte ${index}`).toBeInstanceOf(BoardFormatError); }
      }
    }
  });
  it('single-character corruption of the decoded content never escapes as another exception type', () => {
    for (let index = 0; index < CONTENT.length; index++) {
      for (const replacement of ['!', '-', 'x', '\n', '9', '\u00e9']) {
        try { parse(encode(CONTENT.slice(0, index) + replacement + CONTENT.slice(index + 1)), 'b.fz'); } catch (caught) { expect(caught, `char ${index} -> ${JSON.stringify(replacement)}`).toBeInstanceOf(BoardFormatError); }
      }
    }
  });
});


describe('FZ/CAE: components without pins (OpenBoardView lists them; this format gives a REFDES neither a position nor a body)', () => {
  const notes = (board: { warnings: Array<{ key: string; params?: Record<string, unknown> }> }) => board.warnings.filter(w => w.key === 'parse.warning.formatNote').map(w => String(w.params?.message));
  it('omits a REFDES that owns no pin (mounting hole, logo), discloses it, and still opens the board', () => {
    const content = 'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!\nS!U1!!SOIC8!NO!0!\nS!MH1!!HOLE!NO!0!\nS!R1!!RES0402!YES!90!\nS!LOGO1!!LOGO!NO!0!\n'
      + 'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!\nS!GND!U1!1!VSS!1000!2000!!!\nS!VCC!R1!1!!3000!4000!!!\n';
    const board = parse(encode(content), 'x.fz')!;
    expect(board.components.map(part => [part.ref, part.side, part.pinIds.length])).toEqual([['U1', 'top', 1], ['R1', 'bottom', 1]]);
    expect(notes(board)).toEqual(['2 components without pins were omitted because the file gives no position for them.']);
    const encryptedBoard = parse(encrypted(container(content)), 'x.fz', { fzKey: KEY })!;
    expect(encryptedBoard.components.map(part => part.ref)).toEqual(['U1', 'R1']);
  });
  it('keeps a REFDES that only appears in the description table out of the board, and a file with no pin at all stays an error', () => {
    const only = 'A!REFDES!\nS!MH1!!HOLE!NO!0!\nA!NET_NAME!\n';
    expect(error(() => parse(encode(only), 'x.fz')).message).toMatch(/no components were found/);
    const withDescription = parse(encrypted(container(CONTENT + 'A!REFDES!\nS!MH9!!!NO!0!\n', DESCRIPTION.replace('R1 R9', 'R1 MH9'))), 'x.fz', { fzKey: KEY })!;
    expect(withDescription.components.map(part => part.ref)).not.toContain('MH9');
  });
});
