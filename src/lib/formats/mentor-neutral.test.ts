import { describe, expect, it } from 'vitest';
import { BoardFormatError, MAX_IMPORT_BYTES, textInput } from './common';
import { parseBoardAsync } from './index';
import { parseMentorNeutral } from './mentor-neutral';

const header = ['# file : synthetic.neu', '# date : synthetic', 'BOARD SYNTHETIC OFFSET x:0 y:0 ORIENTATION 0', 'B_UNITS Inches'];
const records = ['COMP R-1 PART RES SHAPE .5 .5 1 90', 'C_PIN R-1-A-1 .4 .5 1 1 90 PAD /POWER', 'C_PIN R-1-2 .6 .5 1 1 90 PAD $NONE$', 'COMP U2 PART IC SHAPE 1 1 2 180', 'C_PIN U2-1 1 1 8 2 180 PAD /POWER'];
const parse = (rows = records, h = header) => parseMentorNeutral(textInput([...h, ...rows].join('\n'), 'synthetic.cad'))!;
const issues = (board: ReturnType<typeof parse>) => board.warnings.filter(i => i.key === 'parse.warning.formatNote').map(i => i.params?.message);

describe('Mentor Neutral placed component records', () => {
  it('dispatches short exports with the narrowly recoverable NUL side or unused property', async () => {
    const input = textInput([...header, 'COMP U1 P IC G 1 2 \0 0', 'C_PROP (DESC,"\0opaque")', 'C_PIN U1-1 1 2 1 1 0 P N'].join('\n'), 'synthetic.cad');
    expect(input.data.length).toBeLessThan(1024);
    const parsed = await parseBoardAsync(input);
    expect(parsed.adapter).toBe('mentor-neutral');
    expect(parsed.board.pins[0]).toMatchObject({ side: 'top', net: 'N' });
    await expect(parseBoardAsync(textInput([...header, 'COMP U1 P IC G 1 2 1 0', 'C_PIN U1-1 1 2 1 1 0 P N\0'].join('\n'), 'synthetic.cad'))).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
  });

  it('checks the byte limit before decoding when called directly', () => {
    expect(() => parseMentorNeutral({ name: 'oversized.neu', data: new Uint8Array(MAX_IMPORT_BYTES + 1) })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });
  it('keeps absolute positions, origin, rotation, actual sides and literal net identity', () => {
    const board = parse();
    expect(board.components.map(c => [c.ref, c.side, c.position, c.rotation])).toEqual([['R-1', 'top', { x: 12.7, y: 12.7 }, 90], ['U2', 'bottom', { x: 25.4, y: 25.4 }, 180]]);
    expect(board.pins.map(p => [p.number, p.x, p.y, p.side, p.net, p.radius])).toEqual([['A-1', .4 * 25.4, 12.7, 'top', '/POWER', 0], ['2', .6 * 25.4, 12.7, 'top', '', 0], ['1', 25.4, 25.4, 'bottom', '/POWER', 0]]);
    expect(board.nets.map(n => n.name)).toEqual(['/POWER']);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.missingBoardOutline' });
  });

  it.each([['Mm.', 1], ['Mils', .0254], ['Inches', 25.4]])('scales all coordinates by the %s declaration', (unit, scale) => {
    const board = parse(['COMP U1 P IC G 2 3 1 0', 'C_PIN U1-1 2 3 1 1 0 PAD N'], [...header.slice(0, -1), `B_UNITS ${unit}`]);
    expect(board.pins[0]).toMatchObject({ x: 2 * scale, y: 3 * scale });
    expect(board.components[0].position).toEqual({ x: 2 * scale, y: 3 * scale });
  });

  it('uses explicit pin geometry for BOM-only parts and omits wholly unplaced records with a note', () => {
    const board = parse(['COMP UNPLACED P IC G', 'COMP TP1 P TP G', 'C_PIN TP1-1 .1 .2 1 1 0 P N']);
    expect(board.components.map(c => c.ref)).toEqual(['TP1']);
    expect(board.pins[0]).toMatchObject({ x: 2.54, y: 5.08, side: 'top' });
    expect(issues(board).join(' ')).toMatch(/1 BOM-only.*1 unplaced/);
  });

  it('tokenizes quoted consumed fields but ignores opaque property quoting', () => {
    const board = parse(["COMP U1 P 'IC package' 'SHAPE ONE' 1 2 1 0", 'C_PROP (DESC,"literal C:\\folder and an unmatched quote)', 'C_PIN U1-1 1 2 1 1 0 PAD N']);
    expect(board.components[0]).toMatchObject({ value: 'IC package', package: 'SHAPE ONE' });
  });

  it('coalesces only geometrically and electrically identical repeated pin identities', () => {
    const board = parse([records[0], records[1], records[1]]);
    expect(board.pins).toHaveLength(1);
    expect(issues(board).join(' ')).toMatch(/1 identical repeated/);
    expect(() => parse([records[0], records[1], records[1].replace('/POWER', '/OTHER')])).toThrow(/conflicting repeated/);
  });

  it('recovers only a NUL component side from agreeing explicit pin sides and discloses damaged opaque metadata', () => {
    const placed = 'COMP U1 P IC G 1 2 \0 0', pin = 'C_PIN U1-1 1 2 1 1 0 P N';
    const board = parse([placed, 'C_PROP (DESC,"\0opaque")', pin, pin.replace('U1-1', 'U1-2')]);
    expect(board.components[0].side).toBe('top');
    expect(issues(board).join(' ')).toMatch(/1 component side fields contain NUL.*1 ancillary/);
    expect(() => parse([placed, pin, pin.replace('U1-1', 'U1-2').replace('1 1 0', '8 2 0')])).toThrow(/side conflicts/);
    expect(() => parse([placed, ...records])).toThrow(/no explicit pin sides/);
    expect(() => parse([placed.replace('P IC', '\0 IC'), pin])).toThrow(/consumed component field/);
    expect(() => parse([records[0], records[1].replace('/POWER', '/PO\0WER')])).toThrow(/consumed pin field/);
  });

  it.each([
    [['C_PIN U1-1 1 2 1 1 0 PAD N'], /owning COMP/],
    [[records[0], 'C_PIN OTHER-1 1 2 1 1 0 PAD N'], /identity/],
    [[records[0], 'C_PIN R-1-1 1 2 1 2 0 PAD N'], /side conflicts/],
    [[records[0], 'C_PIN R-1-1 NaN 2 1 1 0 PAD N'], /pin X/],
    [[records[0], 'C_PIN R-1-1 1 2 1 0 0 PAD N'], /side must/],
    [[records[0], 'C_PIN R-1-1 1 2 1 1 0 PAD'], /fields/],
    [[records[0], records[0], records[1]], /duplicate component/],
  ])('rejects incomplete or conflicting consumed records', (rows, reason) => { expect(() => parse(rows)).toThrow(reason); });

  it('refuses unknown units and unvalidated board transforms without inventing geometry', () => {
    for (const h of [header.map(s => s.replace('Inches', 'CM')), header.map(s => s.replace('x:0', 'x:1')), header.map(s => s.replace('ORIENTATION 0', 'ORIENTATION 90'))]) {
      try { parse(records, h); throw new Error('expected rejection'); } catch (e) { expect(e).toBeInstanceOf(BoardFormatError); expect((e as BoardFormatError).code).toBe('UNSUPPORTED_VARIANT'); }
    }
    expect(parseMentorNeutral(textInput('unrelated'))).toBeNull();
  });
});
