import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { parseBv } from './bv';
import { isJetDatabase, JetDatabase, jetHeaderMask } from './bv-jet';
import { BV_SYNTHETIC_NAILS, BV_SYNTHETIC_PINS, syntheticBv } from './bv-fixtures';
import { BoardFormatError } from './common';
import adapter from './adapters/bv';
import { parseBoard, sniffBoard } from './index';
import { collectDiagnostic } from '../diagnostics/collect';

const input = (data = syntheticBv()) => ({ name: 'synthetic.bv', data });
const mutate = (edit: (bytes: Uint8Array, view: DataView) => void) => { const bytes = syntheticBv(); edit(bytes, new DataView(bytes.buffer)); return bytes; };
const rejects = (bytes: Uint8Array, pattern: RegExp, code = 'INVALID_FORMAT') => {
  let caught: unknown; try { parseBv(input(bytes)); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BoardFormatError); expect(caught).toMatchObject({ code, format: 'Jet BV boardview', message: expect.stringMatching(pattern) });
};

describe('Jet BV tables', () => {
  it.each([false, true])('reports bounded Jet framing without table content (Jet3=%s)', async jet3 => {
    const report = await collectDiagnostic(input(syntheticBv({ jet3 })), { os: 'darwin' });
    expect(report.detection).toMatchObject({ outcome: 'opened', selected: 'bv' });
    expect(report.structure).toMatchObject({ hook: 'bv', variant: jet3 ? 'bv-jet3' : 'bv-jet4', headerOk: true, header: { codes: { version: jet3 ? 3 : 4 }, counts: { declaredPins: 4, declaredNails: 1, declaredOutlinePoints: 4 } } });
    const serialized = JSON.stringify(report); expect(serialized).not.toContain('U1'); expect(serialized).not.toContain('VCC');
  });
  it.each([{}, { compressedText: true, indirectMap: true }, { jet3: true }, { group: false }])('reads complete synthetic tables %j', options => {
    const bytes = syntheticBv(options), db = new JetDatabase(bytes), board = parseBv(input(bytes))!;
    expect(db.version).toBe(options.jet3 ? 3 : 4);
    expect(db.table('Pin', ['Part', 'Name']).count).toBe(4);
    expect(board.components).toHaveLength(3); expect(board.pins).toHaveLength(5);
    expect(board.pins[0]).toMatchObject({ number: 'A1', name: 'A1', x: 6.35, y: -3.175, side: 'top', net: 'VCC', radius: 0 });
    expect(board.pins[2]).toMatchObject({ number: '1', side: 'bottom', net: 'GND' }); expect(board.pins[3].net).toBe('');
    expect(board.components[2]).toMatchObject({ ref: 'TP:25', side: 'bottom' });
    expect(board.pins[4]).toMatchObject({ number: '25', x: 31.75, y: 12.7, side: 'bottom', net: 'VCC' });
    expect(board.bounds).toEqual({ minX: 0, minY: 0, maxX: 50.8, maxY: 25.4 });
    expect(board.warnings.map(w => w.key)).toContain('parse.warning.fallbackPads');
    expect(parseBv(input(bytes))).toEqual(board);
  });
  it('routes by signature under an unrelated name, and exposes .bv through the registry', () => {
    const bytes = syntheticBv();
    expect(sniffBoard(bytes, 'saved.bin').best?.id).toBe('bv'); expect(parseBoard({ name: 'saved.bin', data: bytes }).format).toBe('Jet BV boardview');
    expect(adapter.extensions).toContain('.bv');
    expect(isJetDatabase(new Uint8Array([0, 1, 0, 0]))).toBe(false); expect(parseBv(input(new Uint8Array(100)))).toBeNull();
  });
  it('does not modify the input or require a Buffer global', () => {
    const arrays = [syntheticBv(), Buffer.from(syntheticBv())], copies = arrays.map(bytes => Uint8Array.from(bytes)); vi.stubGlobal('Buffer', undefined);
    try { arrays.forEach((bytes, i) => { expect(parseBv(input(bytes))).not.toBeNull(); expect(Uint8Array.from(bytes)).toEqual(copies[i]); }); }
    finally { vi.unstubAllGlobals(); }
  });
  it('retains Unicode pin names, including blanks, and nullable nets', () => {
    const pins = BV_SYNTHETIC_PINS.map((p, i) => i === 0 ? { ...p, Name: 'Α 1', Net: null } : p);
    expect(parseBv(input(syntheticBv({ pins })))!.pins[0]).toMatchObject({ number: 'Α 1', net: '' });
  });
  it('reads Jet3 variable-field jump boundaries without losing long source text', () => {
    const pins = [{ ...BV_SYNTHETIC_PINS[0], Part: 'R'.repeat(120), Name: 'N'.repeat(140), Net: 'G'.repeat(120) }];
    const bytes = syntheticBv({ jet3: true, pins, nails: [] }), board = parseBv(input(bytes))!;
    expect(board.components[0].ref).toBe(pins[0].Part); expect(board.pins[0]).toMatchObject({ number: pins[0].Name, net: pins[0].Net });
  });
  it('keeps explicit source pin sides on components spanning both sides', () => {
    const pins = BV_SYNTHETIC_PINS.map((p, i) => i === 1 ? { ...p, TB: '(B)' } : p), board = parseBv(input(syntheticBv({ pins })))!;
    expect(board.components[0].side).toBe('both'); expect(board.pins.slice(0, 2).map(p => p.side)).toEqual(['top', 'bottom']);
  });
  it('marks the ordinal fallback for an unnamed pin as generated identity', () => {
    const pins = BV_SYNTHETIC_PINS.map((p, i) => i === 0 ? { ...p, Name: null } : p);
    expect(parseBv(input(syntheticBv({ pins })))!.pins[0]).toMatchObject({ number: '17', numberGenerated: true });
  });
  it('accepts an empty Nail table and discloses straight-segment outline radii', () => {
    const layout = [{ X: 0, Y: 0, R: 0.1, Group: 2 }, { X: 1, Y: 0, R: 0, Group: 2 }, { X: 0, Y: 1, R: 0, Group: 2 }];
    const board = parseBv(input(syntheticBv({ nails: [], layout })))!; expect(board.pins).toHaveLength(4); expect(JSON.stringify(board.warnings)).toContain('straight segments');
  });
  it('refuses multiple Layout groups until their contour semantics are validated', () => {
    const layout = [{ X: 0, Y: 0, R: 0, Group: 1 }, { X: 1, Y: 0, R: 0, Group: 2 }, { X: 0, Y: 1, R: 0, Group: 1 }];
    rejects(syntheticBv({ layout }), /multiple Layout groups/, 'UNSUPPORTED_VARIANT');
  });
  it('refuses an unknown side and duplicate source ordinals without dropping rows', () => {
    rejects(syntheticBv({ pins: [{ ...BV_SYNTHETIC_PINS[0], TB: '(I)' }] }), /side marker/, 'UNSUPPORTED_VARIANT');
    rejects(syntheticBv({ pins: [BV_SYNTHETIC_PINS[0], BV_SYNTHETIC_PINS[0]] }), /duplicate source pin/);
  });
  it('retains rows that reuse a test-point label and discloses the repeated identities', () => {
    const nails = [BV_SYNTHETIC_NAILS[0], { ...BV_SYNTHETIC_NAILS[0], X: 1.5 }], board = parseBv(input(syntheticBv({ nails })))!;
    expect(board.components.filter(p => p.ref === 'TP:25')).toHaveLength(2); expect(board.pins.slice(-2).map(p => p.x)).toEqual([31.75, 38.099999999999994]);
    expect(JSON.stringify(board.warnings)).toContain('reuse a source identifier');
  });
  it('refuses unsupported versions and encrypted data pages explicitly', () => {
    rejects(mutate(bytes => { bytes[20] = 2; }), /only Jet3 and Jet4/, 'UNSUPPORTED_VARIANT');
    const bytes = mutate(bytes => { const clear = jetHeaderMask(bytes.subarray(24, 152)); clear[62 - 24] = 1; bytes.set(jetHeaderMask(clear), 24); });
    rejects(bytes, /encrypted database/, 'UNSUPPORTED_VARIANT');
  });
  it('refuses truncation at page and record boundaries', () => {
    const bytes = syntheticBv(); for (const cut of [20, 21, 128, 4096, bytes.length - 1]) rejects(bytes.subarray(0, cut), /truncated/);
    rejects(mutate((_bytes, v) => { v.setUint16(8 * 4096 + 14, 1, true); }), /row directory/);
    rejects(mutate((_bytes, v) => { v.setUint16(8 * 4096 + 12, 3000, true); }), /truncated|row directory/);
  });
  it('refuses cyclic or out-of-range table links and usage-map references', () => {
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 4, 4, true); }), /cyclic/);
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 4, 99, true); }), /outside/);
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 55, (1 << 8) | 99, true); }), /usage-map row/);
    rejects(mutate((_bytes, v) => { v.setUint32(8 * 4096 + 4, 3, true); }), /another table/);
  });
  it('refuses missing declared rows, excess live rows and count limits', () => {
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 16, 5, true); }), /declared table count/);
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 16, 3, true); }), /more live rows/);
    rejects(mutate((_bytes, v) => { v.setUint32(4 * 4096 + 16, 1_000_001, true); }), /row count/, 'LIMIT_EXCEEDED');
  });
  it('refuses unsupported column types and invalid variable offsets', () => {
    rejects(mutate(bytes => { bytes[4 * 4096 + 63] = 12; }), /unsupported scalar type/, 'UNSUPPORTED_VARIANT');
    rejects(mutate((_bytes, v) => { const start = v.getUint16(8 * 4096 + 14, true); const end = 9 * 4096; v.setUint16(end - 5, start - 1, true); }), /variable-field boundary/);
  });
  it('refuses overflow rows and nonfinite source coordinates', () => {
    rejects(mutate((_bytes, v) => { const at = 8 * 4096 + 14; v.setUint16(at, v.getUint16(at, true) | 0x4000, true); }), /overflow/, 'UNSUPPORTED_VARIANT');
    rejects(syntheticBv({ pins: [{ ...BV_SYNTHETIC_PINS[0], X: Number.NaN }] }), /nonfinite/);
  });
});
