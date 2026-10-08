import { describe, expect, it } from 'vitest';
import { BoardFormatError, textInput, type ParseInput } from './common';
import { hasTeboIctHeader, parseTeboIct, readTeboIctGeometry, readTeboIctProgram, TEBO_ICT_FORMAT } from './tebo-ict';
import { syntheticTeboIct } from './tebo-ict-fixtures';
import { parseBoard, sniffBoard } from './index';
import { companionNames } from './registry';
import { teboIctHook } from './tebo-ict-hook';
import { FactSink } from '../diagnostics/structure';
const input = (geometry = syntheticTeboIct().geometry, program = syntheticTeboIct().program): ParseInput => ({ ...textInput(geometry, 'BOARD_XY'), companions: { BOARD: textInput(program).data } });
const parse = (geometry?: string, program?: string) => parseTeboIct(input(geometry, program))!;
const refused = (geometry: string, program: string, message: RegExp, code = 'INVALID_FORMAT') => {
  let error: unknown; try { parse(geometry, program); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(BoardFormatError); expect(error).toMatchObject({ code, format: TEBO_ICT_FORMAT, message: expect.stringMatching(message) });
};
describe('Tebo ICT explicit geometry / connection pair', () => {
  it.each(['\n', '\r\n', '\r'])('imports either entry with identical ownership, names, coordinates, sides and nets (%j)', eol => {
    const { geometry, program } = syntheticTeboIct(eol), board = parse(geometry, program);
    expect(parseTeboIct({ ...textInput(program, 'BOARD'), companions: { 'path/board_xy': textInput(geometry).data } })).toEqual(board);
    expect(board).toMatchObject({ name: 'board', format: TEBO_ICT_FORMAT, units: 'mm' });
    expect(board.components.map(c => [c.ref, c.side, c.value, c.package])).toEqual([['U1', 'both', '', ''], ['R1', 'bottom', '', '']]);
    expect(board.pins.map(pin => [board.components.find(c => c.id === pin.componentId)!.ref, pin.number, pin.x, pin.y, pin.side, pin.net, pin.radius])).toEqual([
      ['U1', 'A1', 6.35, -3.175, 'top', 'GND', 0], ['U1', 'B2', 12.7, 3.175, 'bottom', 'POWER', 0], ['R1', '1', 25.4, 6.35, 'top', 'GND', 0], ['R1', '2', 38.099999999999994, 6.35, 'bottom', 'POWER', 0],
    ]);
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: 50.8, y: 0 }, { x: 50.8, y: 25.4 }, { x: 0, y: 25.4 }]);
    expect(board.nets.map(n => [n.name, n.pinIds.length])).toEqual([['GND', 2], ['POWER', 2]]);
    expect(board.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ params: { message: expect.stringContaining('3 NO_PROBE') } }), expect.objectContaining({ key: 'parse.warning.fallbackPads', params: { count: 4 } })]));
  });
  it('detects the magic under any filename, gathers only the fixed same-directory role names and keeps bytes immutable', () => {
    const source = input(), before = source.data.slice(), otherBefore = source.companions!.BOARD.slice();
    expect(sniffBoard(source.data, 'backup.bin').best?.id).toBe('tebo-ict');
    expect(parseBoard({ ...source, name: 'backup.ict' }).pins).toHaveLength(4);
    expect(companionNames('C:\\local\\BOARD')).toEqual(['board_xy']); expect(companionNames('BOARD_XY.ict')).toEqual(['board.ict']);
    expect(source.data).toEqual(before); expect(source.companions!.BOARD).toEqual(otherBefore);
    expect(parseTeboIct(textInput('not an ICT export'))).toBeNull(); expect(hasTeboIctHeader(textInput('!Tebo-ict v4.0\n').data)).toBe(false);
  });
  it('requires the other complete role rather than displaying a netless geometry or program', () => {
    for (const text of Object.values(syntheticTeboIct())) expect(() => parseTeboIct(textInput(text))).toThrow(expect.objectContaining({ code: 'COMPANIONS_REQUIRED' }));
    const { geometry, program } = syntheticTeboIct(); refused(geometry, geometry, /CONNECTIONS/);
    expect(() => parseTeboIct({ ...textInput(program, 'BOARD'), companions: { BOARD_XY: textInput(program).data } })).toThrow(/scale 1/);
    expect(() => parseTeboIct({ ...input(), companions: { BOARD: textInput(program).data, 'path/board': textInput(program + '!different').data } })).toThrow(/conflicting copies/);
  });
  it('keeps geometry NODE declarations separate from connectivity and demands both exact node sets', () => {
    const { geometry, program } = syntheticTeboIct();
    const reordered = geometry.replace('NODE GND NO_ACCESS;\nNODE POWER   ;', 'NODE POWER;\nNODE GND NO_ACCESS;'); expect(parse(reordered, program).pins).toEqual(parse().pins);
    refused(geometry.replace('NODE POWER', 'NODE OTHER_NET'), program, /different node sets/);
    refused(geometry, program.replace('POWER;', 'DIFFERENT;'), /NODES disagree/);
    refused(geometry.replace('NODE POWER', 'NODE GND'), program, /duplicate NODE/);
  });
  it('requires a bijection of source Ref.Pin identities, even when the counts are unchanged', () => {
    const { geometry, program } = syntheticTeboIct();
    refused(geometry, program.replace('U1.A1', 'U1.C3'), /identities do not match/);
    refused(geometry.replace('U1.B2', 'U1.A1'), program, /duplicate physical pin/);
    refused(geometry, program.replace('U1.B2', 'U1.A1'), /duplicate or conflicting electrical/);
    refused(geometry.replace('U1.B2', 'U1.B.2'), program, /Ref.Pin/, 'UNSUPPORTED_VARIANT');
    refused(geometry, program.replace('U1.A1\n', ''), /identities do not match/);
  });
  it('checks units, scale, outline framing and the final END of both roles', () => {
    const { geometry, program } = syntheticTeboIct();
    refused(geometry.replace('scale 1;', 'scale 0.1;'), program, /scale 1/, 'UNSUPPORTED_VARIANT');
    refused(geometry.replace('units inches;', 'units mils;'), program, /inch units/, 'UNSUPPORTED_VARIANT');
    refused(geometry.replace('0, 1;', '0, 1'), program, /unterminated outline/);
    refused(geometry.replace('0, 0', '0x10, 0'), program, /outline/);
    refused(geometry.slice(0, geometry.lastIndexOf('END')), program, /final END/);
    refused(geometry, program.slice(0, program.lastIndexOf('END')), /final END/);
    refused(geometry + 'unexpected\n', program, /trailing geometry/);
  });
  it('refuses other physical/probe grammars, duplicate devices and declarations without coordinates', () => {
    const { geometry, program } = syntheticTeboIct();
    refused(geometry.replace('TOP NO_PROBE', 'BOTH NO_PROBE'), program, /physical pin/, 'UNSUPPORTED_VARIANT');
    refused(geometry.replace('NO_PROBE;', 'PREFERRED;'), program, /physical pin/, 'UNSUPPORTED_VARIANT');
    refused(geometry.replace('R1 BOTTOM;', 'R1 TOP;'), program, /bottom-device/, 'UNSUPPORTED_VARIANT');
    refused(geometry.replace('R1 BOTTOM;', 'R1 BOTTOM;\nR1 BOTTOM;'), program, /duplicate device/);
    refused(geometry.replace('R1 BOTTOM;', 'R99 BOTTOM;'), program, /no physical pins/);
    refused(geometry.replace('OTHER', 'NODE GND\nALTERNATES'), program, /NODE declaration/, 'UNSUPPORTED_VARIANT');
  });
  it('requires complete nonempty semicolon-delimited connection groups and strict NODE cells', () => {
    const { geometry, program } = syntheticTeboIct();
    refused(geometry, program.replace('U1.B2 R1.2;', 'U1.B2 R1.2'), /unterminated/);
    refused(geometry, program.replace('GND\nU1.A1\nR1.1;', 'GND;'), /empty connection group/);
    refused(geometry, program.replace('POWER\nU1.B2', 'GND\nU1.B2'), /duplicate connection net/);
    refused(geometry, program.replace('GND;\nPOWER;', 'GND;\nPOWER;\nPOWER;'), /duplicate electrical/);
  });
  it('bounds fields, byte totals and canonical coordinates without exposing or silently truncating names', () => {
    const { geometry, program } = syntheticTeboIct();
    refused(geometry.replace('U1.A1', 'X'.repeat(8193) + '.1'), program, /text field/, 'LIMIT_EXCEEDED');
    expect(() => parseTeboIct({ ...input(), companions: { BOARD: new Uint8Array(64 * 1024 * 1024) } })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(() => parse(geometry.replace('0.25, -0.125', '1e10, -0.125'), program)).toThrow(/supported range/);
    refused(geometry + '\0', program, /binary bytes/);
  });
  it('exposes independently auditable tables while preserving negative and exponent coordinates', () => {
    const { geometry, program } = syntheticTeboIct();
    const table = readTeboIctGeometry(textInput(geometry.replace('0.25, -0.125', '+2.5e-1, -1.25e-1')).data);
    expect(table.pins[0]).toMatchObject({ identity: 'U1.A1', ref: 'U1', pin: 'A1', x: .25, y: -.125, side: 'top', probe: 'NO_PROBE' });
    expect(readTeboIctProgram(textInput(program).data).pinNets.get('U1.A1')).toBe('GND');
  });
  it('collects only rounded generic structure facts, with no source identities or coordinate values', () => {
    const source = input(), sink = new FactSink(teboIctHook, 2);
    teboIctHook.collect({ data: source.data, companions: source.companions!, extension: '.ict', keys: {} }, sink);
    const facts = sink.facts('text', true), serialized = JSON.stringify(facts);
    expect(facts).toMatchObject({ hook: 'generic-text', headerOk: true, keywords: { NODE: 2, UNITS: 1 }, header: { codes: { version: 30 }, counts: { companionFiles: 1 } } });
    for (const text of ['U1', 'R1', 'A1', 'GND', 'POWER', '-0.125', 'BOARD_XY']) expect(serialized).not.toContain(text);
  });
});
