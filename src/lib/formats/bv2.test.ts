import { describe, expect, it } from 'vitest';
import { parseBv2, readBv2Tables, hasBv2Header } from './bv2';
import { parseBv } from './bv';
import { syntheticBv } from './bv-fixtures';
import { syntheticBv2 } from './bv2-fixtures';
import { BoardFormatError, textInput } from './common';
import { parseBoard, sniffBoard } from './index';
const parse = (text = syntheticBv2()) => parseBv2(textInput(text, 'synthetic.bv2'))!;
const rejects = (text: string, pattern: RegExp, code = 'INVALID_FORMAT') => {
  let caught: unknown; try { parse(text); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BoardFormatError); expect(caught).toMatchObject({ format: 'BV2 text boardview', code, message: expect.stringMatching(pattern) });
};
describe('BV2 CSV boardview tables', () => {
  it.each(['\n', '\r\n', '\r'])('maps complete tables in %j line endings as the Jet cousin does', eol => {
    const board = parse(syntheticBv2({ eol })), jet = parseBv({ name: 'synthetic.bv', data: syntheticBv() })!;
    for (const field of ['components', 'pins', 'outline', 'nets', 'bounds'] as const) expect(board[field]).toEqual(jet[field]);
    expect(readBv2Tables(textInput(syntheticBv2()).data)).toMatchObject({ hasGroup: true, layout: expect.any(Array), pins: expect.any(Array), nails: expect.any(Array) });
  });
  it('routes .bv2 by its signature even under another extension', () => {
    const { data } = textInput(syntheticBv2()); expect(sniffBoard(data, 'backup.bin').best?.id).toBe('bv2'); expect(parseBoard({ data, name: 'backup.bin' }).format).toBe('BV2 text boardview');
    expect(hasBv2Header(textInput('Part,Pin,X,Y,Net\nU1,1,2,3,GND').data)).toBe(false); expect(parseBv2(textInput('not a board', 'wrong.bv2'))).toBeNull();
  });
  it('preserves quoted names, commas, doubled quotes and embedded line breaks', () => {
    const name = 'A, "1"\nrow', net = 'POWER, "A"'; const board = parse(syntheticBv2({ name, net, group: false }));
    expect(board.pins[0]).toMatchObject({ number: name, name, net }); expect(board.bounds.maxX).toBe(50.8);
  });
  it('accepts signed exponent coordinates and source labels that differ from numeric ordinals', () => {
    const board = parse(syntheticBv2().replace('0.25,-0.125', '+2.5E-1,-1.25e-1'));
    expect(board.pins[0]).toMatchObject({ number: 'A1', x: 6.35, y: -3.175 });
  });
  it('checks numeric and positive MIL test-point annotations without inventing physical dimensions', () => {
    const text = syntheticBv2().replace('$25,1.25,0.5,0,', '$25,1.25,0.5,100MIL,');
    expect(readBv2Tables(textInput(text).data)!.nails[0].Type).toBe('100MIL');
    expect(parse(text).pins).toEqual(parse().pins);
    const noProbe = parse(text.replace('100MIL', 'NO_PROBE'));
    expect(noProbe.pins).toEqual(parse().pins); expect(noProbe.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ params: { message: expect.stringContaining('NO_PROBE') } })]));
    for (const type of ['0MIL', '-100MIL', '100MM', '100MILextra', '1e999MIL', '0.5']) rejects(text.replace('100MIL', type), /Nail Type|test-point type/);
  });
  it('uses source pin names for identity when CSV ordinals repeat', () => {
    const text = syntheticBv2().replace('U1,(T),18,B2', 'U1,(T),17,B2');
    expect(parse(text).pins.filter(pin => pin.number === 'A1' || pin.number === 'B2')).toHaveLength(2);
    rejects(text.replace('U1,(T),17,B2', 'U1,(T),17,A1'), /duplicate source pin name/);
  });
  it('accepts UTF-8 BOM and valid UTF-16 BOM input', () => {
    expect(parse('\uFEFF' + syntheticBv2()).pins).toHaveLength(5);
    const text = syntheticBv2({ name: 'Α1' }), bytes = new Uint8Array(2 + text.length * 2), view = new DataView(bytes.buffer); bytes.set([255, 254]);
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
    expect(parseBv2({ name: 'utf16.bv2', data: bytes })!.pins[0].number).toBe('Α1');
    expect(() => parseBv2({ name: 'utf16.bv2', data: bytes.subarray(0, bytes.length - 1) })).toThrow(/truncated UTF-16/);
  });
  it('requires all sections and complete column headers, including an empty Nail table', () => {
    rejects('#Layout#\n', /column header/);
    rejects('#Layout#\nX,Y,R\n0,0,0\n', /all required/);
    const text = syntheticBv2().replace('$25,1.25,0.5,0,G1,(B),99,VCC\n', ''); expect(parse(text).pins).toHaveLength(4);
    rejects(syntheticBv2().replace('#Nail#', '#Unknown#'), /unknown/, 'UNSUPPORTED_VARIANT');
    rejects(syntheticBv2() + '#Pin#\nPart,TB,Pin,Name,X,Y,Layer,Netname\n', /duplicate/);
  });
  it('refuses unsupported header aliases, wrong field counts and partial records', () => {
    rejects(syntheticBv2().replace('X,Y,R,Group', 'X,Y,Radius,Group'), /column header/, 'UNSUPPORTED_VARIANT');
    rejects(syntheticBv2().replace('U1,(T),17,A1,0.25,-0.125,1,VCC', 'U1,(T),17,A1,0.25'), /field count/);
    rejects(syntheticBv2().replace('U1,(T),17,A1,0.25,-0.125,1,VCC', 'U1,(T),17,"A1,0.25,-0.125,1,VCC'), /CSV record/);
    rejects(syntheticBv2().replace('U1,(T),17,A1,', 'U1,(T),17,A"1,'), /stray quote/);
  });
  it('refuses nondecimal coordinates, fractional ordinals and unknown sides', () => {
    rejects(syntheticBv2().replace('0.25,-0.125', '0x10,-0.125'), /Invalid Pin X/);
    rejects(syntheticBv2().replace('U1,(T),17,', 'U1,(T),17.5,'), /pin ordinal/);
    rejects(syntheticBv2().replace('U1,(T),17,', 'U1,(I),17,'), /side marker/, 'UNSUPPORTED_VARIANT');
  });
  it('refuses oversized fields rather than silently cutting source identities', () => {
    rejects(syntheticBv2({ name: 'N'.repeat(8193) }), /oversized CSV/, 'LIMIT_EXCEEDED');
  });
});
