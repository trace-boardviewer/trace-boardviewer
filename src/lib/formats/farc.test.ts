import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseFarc } from './farc';
import { farcFixture } from './adapters/farc/fixtures';
import { parseBoardAsync } from './dispatch';
const parse = (text = farcFixture) => parseFarc({ name: 'synthetic.far', data: strToU8(text) });
describe('bounded Fabmaster FARC jobs', () => {
  it('preserves absolute positions, package pin names, sides and disconnected membership', () => {
    const board = parse()!;
    expect(board.components.map(part => [part.ref, part.side])).toEqual([['J_TEST', 'top'], ['R_TEST', 'bottom'], ['TP:4', 'both']]);
    expect(board.pins).toHaveLength(4); expect(board.nets).toHaveLength(1);
    expect(board.pins[0]).toMatchObject({ number: 'A', x: 25.4, y: 25.4, side: 'top', net: 'SYNTHETIC_NET' });
    expect(board.pins[1]).toMatchObject({ number: 'B', x: 25.4, side: 'both' }); expect(board.pins[1].y).toBeCloseTo(27.94);
    expect(board.pins[1].net).toBe(''); expect(board.pins[2].x).toBeCloseTo(38.1); expect(board.outline).toHaveLength(4); expect(Math.max(...board.outline.map(point => point.x))).toBeCloseTo(50.8);
    expect(board.components[2].refGenerated).toBe(true); expect(board.warnings.length).toBeGreaterThan(0);
  });
  it('opens the complete job from a FAZ without mistaking library files for separate boards', async () => {
    const data = zipSync({ 'job.FAR': strToU8(farcFixture), 'DEVICE.ASC': strToU8(':REM library'), 'iperror.asc': strToU8(':SCREEN_INFO Unit : MILS') });
    const parsed = await parseBoardAsync({ name: 'synthetic.faz', data }); expect(parsed.adapter).toBe('farc'); expect(parsed.board.pins).toHaveLength(4);
  });
  it('declines unrelated files', () => { expect(parseFarc({ name: 'board.cad', data: strToU8('$HEADER\nGENCAD 1.4') })).toBeNull(); });
  it('recognizes a FAZ job renamed to FZ by its bounded ZIP job clue', async () => {
    const data = zipSync({ 'iperror.asc': strToU8(':SCREEN_INFO Unit : MILS'), 'job.FAR': strToU8(farcFixture) });
    const parsed = await parseBoardAsync({ name: 'misleading.fz', data }); expect(parsed.adapter).toBe('farc'); expect(parsed.board.pins).toHaveLength(4);
    expect(parseFarc({ name: 'unrelated.fz', data: zipSync({ 'other.txt': strToU8('unrelated') }) })).toBeNull();
    expect(() => parseFarc({ name: 'damaged.fz', data: zipSync({ 'iperror.asc': strToU8('clue only') }) })).toThrow(/exactly one/);
  });
  it('treats sparse tester IDs as bookkeeping, not physical pin identities', () => {
    const board = parse(farcFixture.replace('TPIN 0 11', 'TPIN 0 0').replace('BPIN 0 13', 'BPIN 0 0'))!; expect(board.pins).toHaveLength(4);
  });
  it('links packages by the library filename rather than the display name', () => {
    const board = parse(farcFixture.replaceAll('("TEST" "TEST"', '("Long display name" "TEST"'))!; expect(board.pins[0].number).toBe('A'); expect(board.components[0].package).toBe('Long display name');
  });
  it('rejects repeated unterminated sections without scanning each suffix', () => { expect(() => parse(':SECTION FABMASTER 1\n' + ':SECTION PARTS 1\n'.repeat(10_000))).toThrow(/section boundary/); });
  it.each([
    ['component count', farcFixture.replace('2((1"J_TEST"', '3((1"J_TEST"')],
    ['XY count', farcFixture.replace('4(2 3', '5(2 3')],
    ['membership', farcFixture.replace('1500 1000 1 2 1 BPIN', '1500 1000 2 2 1 BPIN')],
    ['pin identity', farcFixture.replace('1 2 DPIN', '1 9 DPIN')],
    ['unknown part', farcFixture.replace('1 2 1 BPIN', '1 99 1 BPIN')],
    ['duplicate physical pin', farcFixture.replace('1 2 1 BPIN', '1 1 1 BPIN')],
    ['missing terminator', farcFixture.slice(0, farcFixture.indexOf(':SECTION EOARCHIVE'))],
    ['trailing data', farcFixture + 'injected'],
    ['unclosed string', farcFixture.replace('"SYNTHETIC_NET"', '"SYNTHETIC_NET')],
    ['numeric overflow', farcFixture.replace('1000 1000 1 1', '1e999 1000 1 1')],
  ])('refuses %s', (_label, text) => { expect(() => parse(text)).toThrow(); });
  it('preserves explicitly mixed physical pin sides with a notice', () => {
    const board = parse(farcFixture.replace('1 BPIN', '1 TPIN').replace('0 0 BPIN', '0 0 TPIN'))!;
    expect(board.components[1].side).toBe('both'); expect(board.pins[2].side).toBe('top'); expect(board.warnings.some(warning => String(warning.params?.message).includes('both physical sides'))).toBe(true);
  });
  it('discloses open outline chains without inventing their closure', () => {
    const board = parse(farcFixture.replace('(0 2000)(0 0)', '(0 2000)(1 0)'))!;
    expect(board.warnings.some(warning => String(warning.params?.message).includes('open outline chains'))).toBe(true);
  });
  it.each([
    ['section revision', farcFixture.replace(':SECTION PARTS 1', ':SECTION PARTS 2')],
    ['unknown placement flag', farcFixture.replace('[BOTTOM SELECTED]', '[BOTTOM MYSTERY]')],
    ['unknown XY type', farcFixture.replaceAll('DVIA', 'MYSTERY')],
    ['unknown outline primitive', farcFixture.replace('TRACK 1', 'CIRCLE 1')],
  ])('explains an unsupported %s', (_label, text) => { try { parse(text); throw Error('must fail'); } catch (error) { expect(error).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: 'farc' }); } });
  it('bounds nesting', () => { const text = farcFixture.replace('2((1 1"SYNTHETIC_NET"', `${'('.repeat(70)}2((1 1"SYNTHETIC_NET"`); try { parse(text); throw Error('must fail'); } catch (error) { expect(error).toMatchObject({ code: 'LIMIT_EXCEEDED' }); } });
  it('refuses multiple FAR boards and a corrupt ZIP member', () => {
    const data = zipSync({ 'a.FAR': strToU8(farcFixture), 'b.FAR': strToU8(farcFixture) }); expect(() => parseFarc({ name: 'many.faz', data })).toThrow(/exactly one/);
    const damaged = zipSync({ 'a.FAR': strToU8(farcFixture) }); damaged[40] ^= 0xff; expect(() => parseFarc({ name: 'bad.faz', data: damaged })).toThrow();
  });
});
