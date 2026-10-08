import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { parseCst } from './cst';

interface CstOptions { layer?: number; pins?: Array<[part: number, net: number, x: number, y: number]>; partCount?: number; netCount?: number; pinCount?: number; cpad?: string; nets?: string[]; parts?: string[]; partLayers?: number[] }
/** Builds a synthetic CST file with explicit part, net and pin counts. */
function makeCst({ layer = 12, parts = ['U1'], partLayers, pins = [[0, 0, 100, 200]], partCount = parts.length, nets = ['GND'], netCount = nets.length, pinCount = pins.length, cpad = 'CPad' }: CstOptions = {}): Uint8Array {
  const data: number[] = [];
  const u16 = (value: number) => data.push(value & 255, value >>> 8 & 255);
  const text = (value: string) => data.push(...new TextEncoder().encode(value));
  u16(partCount); data.push(0, 0, 0, 0); u16(4); text('CDev');
  parts.forEach((ref, index) => { data.push(ref.length); text(ref); data.push(0, 0, 0, 0, partLayers?.[index] ?? layer, 0, 0, 0, 0); u16(index === parts.length - 1 ? netCount : 0); });
  for (const net of nets) { data.push(net.length); text(net); }
  u16(pinCount); data.push(0, 0, 0, 0); u16(4); text(cpad);
  pins.forEach(([part, net, x, y], index) => { u16(part); u16(index + 1); u16(net); u16(x); u16(y); u16(0); data.push(0, 0, 0, 0); });
  return Uint8Array.from(data);
}
const parse = (data: Uint8Array, name = 'synthetic.cst') => parseCst({ name, data });
function error(run: () => unknown): BoardFormatError {
  try { run(); } catch (caught) { if (caught instanceof BoardFormatError) return caught; throw caught; }
  throw new Error('expected a BoardFormatError');
}

describe('parseCst', () => {
  it('imports the synthetic CDev/CPad board with mil geometry, sides and nets', () => {
    const board = parse(makeCst({ parts: ['U1', 'R7'], partLayers: [12, 1], nets: ['GND', 'VCC'], pins: [[0, 0, 100, 200], [1, 1, -50, 25], [1, 0, 0, 0]] }))!;
    expect(board.format).toBe('CST'); expect(board.name).toBe('synthetic'); expect(board.units).toBe('mm');
    expect(board.components.map(part => [part.ref, part.side])).toEqual([['U1', 'top'], ['R7', 'bottom']]);
    expect(board.pins).toHaveLength(3);
    expect(board.pins[0]).toMatchObject({ componentId: board.components[0].id, number: '1', net: 'GND', side: 'top', radius: 0 });
    expect(board.pins[0].x).toBeCloseTo(2.54, 12); expect(board.pins[0].y).toBeCloseTo(5.08, 12);
    expect(board.pins[1]).toMatchObject({ componentId: board.components[1].id, number: '2', net: 'VCC', side: 'bottom' });
    expect(board.pins[1].x).toBeCloseTo(-1.27, 12); expect(board.pins[1].y).toBeCloseTo(0.635, 12);
    expect(board.nets.map(net => [net.name, net.pinIds.length])).toEqual([['GND', 2], ['VCC', 1]]);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 3 } });
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
  });

  it('attaches negative part ids to one ICT orphan on both sides', () => {
    const board = parse(makeCst({ pins: [[0, 0, 100, 200], [-1, 0, 300, 400], [-1, 0, 500, 600]] }))!;
    expect(board.components.map(part => [part.ref, part.side])).toEqual([['U1', 'top'], ['ICT', 'both']]);
    expect(board.pins.map(pin => pin.componentId)).toEqual([board.components[0].id, board.components[1].id, board.components[1].id]);
    expect(board.pins[1].side).toBe('both');
  });

  it('B03: validates pin part ids against the declared part count even after the orphan grows the part list', () => {
    const failure = error(() => parse(makeCst({ pins: [[0, 0, 100, 200], [-1, 0, 101, 201], [1, 0, 102, 202]] })));
    expect(failure.message).toMatch(/pin 3 references component 1 but only 1 are declared/);
    expect(error(() => parse(makeCst({ pins: [[1, 0, 100, 200]] }))).message).toMatch(/pin 1 references component 1/);
  });

  it('recognizes observed but unvalidated layer variants without inventing a side', () => {
    for (const layer of [4, 8, 9, 10]) {
      const failure = error(() => parse(makeCst({ layer })));
      expect(failure).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'CST' });
      expect(failure.message).toMatch(/top\/bottom mapping is not validated/);
    }
  });

  it('B04: rejects undocumented layer codes instead of inventing a side', () => {
    const failure = error(() => parse(makeCst({ layer: 255 })));
    expect(failure).toMatchObject({ code: 'INVALID_FORMAT', format: 'CST' });
    expect(failure.message).toMatch(/unsupported component layer code 0xff for U1/);
    expect(error(() => parse(makeCst({ layer: 0 }))).message).toMatch(/layer code 0x00/);
    expect(parse(makeCst({ layer: 1 }))!.components[0].side).toBe('bottom');
    expect(parse(makeCst({ layer: 12 }))!.components[0].side).toBe('top');
  });

  it('B03: a pin id equal to the declared count stays invalid however many orphans precede it, and ids at the boundary pass', () => {
    const two = { parts: ['U1', 'U2'], partLayers: [12, 1] };
    expect(parse(makeCst({ ...two, pins: [[0, 0, 0, 0], [-1, 0, 1, 1], [-32768, 0, 2, 2], [1, 0, 3, 3]] }))!.components.map(part => part.ref)).toEqual(['U1', 'U2', 'ICT']);
    expect(error(() => parse(makeCst({ ...two, pins: [[-1, 0, 1, 1], [2, 0, 3, 3]] }))).message).toMatch(/pin 2 references component 2 but only 2 are declared/);
    expect(error(() => parse(makeCst({ ...two, pins: [[32767, 0, 3, 3]] }))).message).toMatch(/references component 32767 but only 2/);
  });

  it('B04: the layer is checked per component and names the offending one; no component is ever placed on both sides by layer', () => {
    const failure = error(() => parse(makeCst({ parts: ['U1', 'R7'], partLayers: [12, 255] })));
    expect(failure.message).toMatch(/unsupported component layer code 0xff for R7/);
    const board = parse(makeCst({ parts: ['U1', 'R7', 'C1'], partLayers: [12, 1, 12], pins: [[0, 0, 1, 1], [1, 0, 2, 2], [2, 0, 3, 3]] }))!;
    expect(board.components.map(part => part.side)).toEqual(['top', 'bottom', 'top']);
    for (const layer of [2, 3, 8, 0x0b, 0x0d, 0x80, 0xfe]) expect(error(() => parse(makeCst({ layer }))).code, `layer ${layer}`).toBe(layer === 8 ? 'UNSUPPORTED_VARIANT' : 'INVALID_FORMAT');
  });

  it('decodes binary names without byte-order-mark sniffing, so hostile bytes cannot escape as a TypeError', () => {
    const data = makeCst({ parts: ['ABCD'] });
    data.set([0xff, 0xfe, 0x41, 0xd8], 13); // UTF-16LE BOM + lone surrogate: fatal under the text sniffer
    expect(parse(data)!.components[0].ref).toBe('\u00ff\u00fe\u0041\u00d8');
    const utf8 = makeCst({ parts: ['AB'], nets: ['N1'] });
    utf8.set([0xc3, 0xa9], 13); // "é" in UTF-8 is kept as such
    expect(parse(utf8)!.components[0].ref).toBe('\u00e9');
  });

  it('keeps int16 coordinates inside the canonical range (B16: the format cannot express an absurd magnitude)', () => {
    const board = parse(makeCst({ pins: [[0, 0, -32768, 32767]] }))!;
    expect(board.pins[0].x).toBeCloseTo(-32768 * 0.0254, 9); expect(board.pins[0].y).toBeCloseTo(32767 * 0.0254, 9);
    expect(Math.max(...Object.values(board.bounds).map(Math.abs))).toBeLessThan(1000);
  });

  it('omits components that own no pin (CST has no body geometry) and discloses the count', () => {
    const board = parse(makeCst({ parts: ['U1', 'R7', 'C3'], partLayers: [12, 1, 12], pins: [[1, 0, 10, 20]] }))!;
    expect(board.components.map(part => part.ref)).toEqual(['R7']);
    expect(board.pins[0].componentId).toBe(board.components[0].id);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.formatNote', params: { message: 'CST: 2 components own no test pad and have no geometry in this format; they are omitted.' } });
    expect(error(() => parse(makeCst({ pins: [] }))).message).toMatch(/no components were found/);
  });

  it('recognizes CST by the CDev header only, regardless of extension', () => {
    expect(parse(makeCst(), 'renamed.bin')!.components).toHaveLength(1);
    expect(parse(new TextEncoder().encode('$HEADER\nGENCAD 1.4\n$ENDHEADER\n'), 'board.cst')).toBeNull();
    expect(parse(new Uint8Array(0), 'empty.cst')).toBeNull();
    const damaged = makeCst(); damaged[9] = 0x58;
    expect(parse(damaged)).toBeNull();
  });

  it('fails cleanly on truncated records, negative counts and a missing CPad section', () => {
    const valid = makeCst();
    for (const length of [12, 14, 20, 24, valid.length - 1]) expect(error(() => parse(valid.subarray(0, length))).message).toMatch(/truncated|missing CPad/);
    expect(error(() => parse(makeCst({ partCount: 0 }))).message).toMatch(/no component records/);
    expect(error(() => parse(makeCst({ partCount: -1 }))).message).toMatch(/negative record count/);
    expect(error(() => parse(makeCst({ netCount: -2 }))).message).toMatch(/negative record count/);
    expect(error(() => parse(makeCst({ pinCount: -1 }))).message).toMatch(/negative record count/);
    expect(error(() => parse(makeCst({ pinCount: 2 }))).message).toMatch(/truncated/);
    expect(error(() => parse(makeCst({ cpad: 'CPax' }))).message).toMatch(/missing CPad/);
    expect(error(() => parse(makeCst({ pins: [[0, 5, 1, 1]] }))).message).toMatch(/invalid net/);
    expect(error(() => parse(makeCst({ pins: [[0, -1, 1, 1]] }))).message).toMatch(/invalid net/);
    expect(error(() => parse(makeCst({ parts: [''] }))).message).toMatch(/empty component name/);
  });

  it('truncating a valid file at every prefix length either stays unrecognized or throws BoardFormatError', () => {
    const valid = makeCst({ parts: ['U1', 'R7'], partLayers: [12, 1], nets: ['GND', 'VCC'], pins: [[0, 0, 100, 200], [1, 1, -50, 25], [-1, 0, 7, 8]] });
    expect(parse(valid)).not.toBeNull();
    for (let length = 0; length < valid.length; length++) {
      const prefix = valid.subarray(0, length);
      if (length < 12) expect(parse(prefix), `length ${length}`).toBeNull();
      else expect(() => parse(prefix), `length ${length}`).toThrow(BoardFormatError);
    }
  });

  it('survives every single-byte corruption with a board, null or BoardFormatError', () => {
    const valid = makeCst({ parts: ['U1', 'R7'], partLayers: [12, 1], nets: ['GND', 'VCC'], pins: [[0, 0, 100, 200], [1, 1, -50, 25], [-1, 0, 7, 8]] });
    for (let index = 0; index < valid.length; index++) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const damaged = Uint8Array.from(valid); damaged[index] ^= mask;
        try { parse(damaged); } catch (caught) { expect(caught, `byte ${index} ^ ${mask}`).toBeInstanceOf(BoardFormatError); }
      }
    }
  });

  it('rejects absurd declared counts before reading records (no allocation proportional to the claim)', () => {
    const header = makeCst().subarray(0, 12);
    header.set([0xff, 0x7f]); // 32767 components declared, none present
    expect(error(() => parse(header)).message).toMatch(/truncated/);
    expect(error(() => parse(makeCst({ pinCount: 32767 }))).message).toMatch(/truncated/);
  });
});
