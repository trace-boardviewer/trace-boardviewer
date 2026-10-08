import { describe, expect, it } from 'vitest';
import type { Board } from '../types';
import { BoardFormatError } from './common';
import { parseAsc } from './asc';
import { parseBdv } from './bdv';
import { parseBoardDetailed } from './dispatch';

const inch = (value: number) => value * 25.4;
const header = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `; ${tag} header ${index + 1}`);
const FORMAT = ['0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000'];
const PINS = [
  'Part U1 (T)',
  '1  1  0.100 0.200  1  VCC  5',
  '2  2  0.150 0.200  1  UNCONNECTED12  0',
  'Part R1 (B)',
  '1  A 1  1.500 0.500  2  GND  7',
  '2  2  1.600 0.500  2  UNCONNECTED  0',
];
const NAILS = ['*5  0.100 0.200  1  G1 (T) 11  VCC', '#6  1.500 0.500  2  G2 (B) 12  GND'];
const join = (rows: string[], eol = '\r\n') => rows.join(eol) + eol;
const bytes = (value: string) => new TextEncoder().encode(value);
const files = (format = FORMAT, pins = PINS, nails = NAILS, eol?: string) => ({
  'format.asc': bytes(join([...header(8, 'format'), ...format], eol)),
  'pins.asc': bytes(join([...header(8, 'pins'), ...pins], eol)),
  'nails.asc': bytes(join([...header(7, 'nails'), ...nails], eol)),
});
type Trio = ReturnType<typeof files>;
type Entry = keyof Trio;
const ENTRIES: Entry[] = ['format.asc', 'pins.asc', 'nails.asc'];
/** The entry file as `data`, the other two as companions (and, optionally, the entry again among them). */
function open(trio: Trio, entry: Entry, directory = '', duplicate = false) {
  const companions = Object.fromEntries(ENTRIES.filter(name => duplicate || name !== entry).map(name => [name, trio[name]]));
  return { name: directory + entry, data: trio[entry], companions };
}
const must = (input: Parameters<typeof parseAsc>[0]): Board => {
  const board = parseAsc(input);
  if (!board) throw new Error('fixture was not recognized');
  return board;
};
function thrown(input: Parameters<typeof parseAsc>[0]): BoardFormatError {
  try { parseAsc(input); } catch (error) { if (error instanceof BoardFormatError) return error; throw error; }
  throw new Error('expected a BoardFormatError');
}
const notes = (board: Board) => board.warnings.filter(issue => issue.key === 'parse.warning.formatNote').map(issue => String(issue.params?.message));
const pinRows = (board: Board) => board.pins.map(pin => {
  const component = board.components.find(candidate => candidate.id === pin.componentId)!;
  return [component.ref, pin.number, pin.x, pin.y, pin.net, pin.side] as const;
});

describe('ASC companion trio', () => {
  it('opens only the exact @format.asc alias, preferring ordinary format for pins/nails entries', () => {
    const normal = files(), alternate = files(['0 0', '3 0', '3 2', '0 2']);
    const companions = { ...normal, '@FORMAT.ASC': alternate['format.asc'] };
    const fromAt = parseBoardDetailed({ name: '@FoRmAt.AsC', data: alternate['format.asc'], companions }).board;
    expect(fromAt.outline).toEqual(must(open(alternate, 'format.asc')).outline);
    expect(fromAt.pins).toEqual(must(open(normal, 'format.asc')).pins);
    for (const entry of ENTRIES) expect(must({ name: entry, data: normal[entry], companions }).outline).toEqual(must(open(normal, 'format.asc')).outline);
    const noNormal = { 'folder/@FORMAT.ASC': alternate['format.asc'], 'pins.asc': normal['pins.asc'], 'nails.asc': normal['nails.asc'] };
    for (const entry of ['pins.asc', 'nails.asc'] as const) expect(must({ name: entry, data: normal[entry], companions: noNormal }).outline).toEqual(fromAt.outline);
    expect(parseAsc({ name: '@@format.asc', data: alternate['format.asc'], companions })).toBeNull();
    expect(parseAsc({ name: '@pins.asc', data: normal['pins.asc'], companions })).toBeNull();
    expect(() => must({ name: 'pins.asc', data: normal['pins.asc'], companions: { ...noNormal, 'format.asc': bytes('BROKEN\n') } })).toThrow();
  });

  it('accepts the exporter\'s mixed-case Part keyword and FPT nail type from every entry', () => {
    const trio = files(FORMAT, ['PART U1 (T)', '1 1 .1 .2 1 VCC 0', 'ParT U2 (B)', '1 1 .3 .2 2 GND 0'], ['*5 .1 .2 FPT A1 (T) 11 VCC']);
    const boards = ENTRIES.map(entry => must(open(trio, entry)));
    expect(boards[1]).toEqual(boards[0]); expect(boards[2]).toEqual(boards[0]);
    expect(boards[0].components.map(part => [part.ref, part.side])).toEqual([['U1', 'top'], ['U2', 'bottom'], ['TP:5', 'top']]);
    expect(boards[0].pins.at(-1)).toMatchObject({ net: 'VCC', x: inch(.1), y: inch(.2), side: 'top' });
    expect(notes(boards[0])).toContain('The FPT test point type is retained as a test point; type annotations do not change its coordinates or net.');
    expect(() => must(open(files(FORMAT, PINS, ['*5 .1 .2 UNKNOWN A1 (T) 11 VCC']), 'format.asc'))).toThrow(/invalid test point type/);
  });

  it('opens each entry when the format companion has a final NUL terminator', () => {
    const trio = files();
    trio['format.asc'] = bytes(new TextDecoder().decode(trio['format.asc']) + '\0\0\0\n');
    for (const entry of ENTRIES) expect(must(open(trio, entry)).pins).toEqual(must(open(files(), entry)).pins);
  });

  it('dispatches a complete short ASC entry with terminal NUL padding to the trio reader', () => {
    const trio = files();
    trio['format.asc'] = bytes(new TextDecoder().decode(trio['format.asc']) + '\0\0\n');
    const parsed = parseBoardDetailed(open(trio, 'format.asc'));
    expect(parsed.adapter).toBe('asc');
    expect(parsed.board.pins).toEqual(must(open(files(), 'format.asc')).pins);
  });

  it('retains the first outline point when the banner is shortened', () => {
    const trio = files();
    trio['format.asc'] = bytes(join([...header(7, 'format'), ...FORMAT]));
    const board = must(open(trio, 'format.asc'));
    expect(board.outline).toEqual(must(open(files(), 'format.asc')).outline);
    expect(notes(board)).toContain('ASC format.asc: read a shortened header (7 of the usual 8 lines).');
  });

  it('reads the optional outline radius and comma-separated or wrapped probe lists from every entry', () => {
    const trio = files(FORMAT.map((row, index) => `${row} ${index === 1 ? '.1' : '0'}`), [
      'Part U1 (T)', '1 A 1 .1 .2 1 POWER RAIL 5,6', ',7,8', '2 2 .15 .2 1 GND',
    ]);
    const boards = ENTRIES.map(entry => must(open(trio, entry)));
    expect(boards[1]).toEqual(boards[0]); expect(boards[2]).toEqual(boards[0]);
    expect(boards[0].pins.slice(0, 2).map(pin => [pin.number, pin.net, pin.x, pin.y])).toEqual([
      ['A 1', 'POWER RAIL', inch(.1), inch(.2)], ['2', 'GND', inch(.15), inch(.2)],
    ]);
    expect(boards[0].outline).toHaveLength(4);
    expect(notes(boards[0])).toContain('1 outline point carries a non-zero radius; the outline is shown with straight segments, as OpenBoardView does.');
  });

  it('parses the golden trio with inch units, part-line sides and test points', () => {
    const board = must(open(files(), 'format.asc'));
    expect(board.format).toBe('ASC companion trio');
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['R1', 'bottom'], ['TP:5', 'top'], ['TP:6', 'bottom']]);
    expect(pinRows(board)).toEqual([
      ['U1', '1', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['U1', '2', inch(0.15), inch(0.2), '', 'top'],
      ['R1', 'A 1', inch(1.5), inch(0.5), 'GND', 'bottom'],
      ['R1', '2', inch(1.6), inch(0.5), '', 'bottom'],
      ['TP:5', '5', inch(0.1), inch(0.2), 'VCC', 'top'],
      ['TP:6', '6', inch(1.5), inch(0.5), 'GND', 'bottom'],
    ]);
    expect(board.outline).toEqual([{ x: 0, y: 0 }, { x: inch(2), y: 0 }, { x: inch(2), y: inch(1) }, { x: 0, y: inch(1) }]);
    expect(board.pins.every(pin => pin.radius === 0 && pin.width === undefined)).toBe(true);
    expect(board.nets.map(net => net.name).sort()).toEqual(['GND', 'VCC']);
    expect(notes(board)).toEqual(['2 pins marked UNCONNECTED by the exporter are shown without a net.']);
    expect(board.warnings).toContainEqual({ key: 'parse.warning.fallbackPads', params: { count: 6 } });
  });
  it('yields the identical Board whichever of the three files is chosen (B32)', () => {
    const trio = files();
    const [fromFormat, fromPins, fromNails] = ENTRIES.map(entry => must(open(trio, entry)));
    expect(fromPins).toEqual(fromFormat);
    expect(fromNails).toEqual(fromFormat);
    expect(fromFormat.name).toBe('format');
    for (const entry of ENTRIES) {
      expect(must(open(trio, entry, '', true)), `entry duplicated among companions: ${entry}`).toEqual(fromFormat);
      expect(must({ name: entry.toUpperCase(), data: trio[entry], companions: { 'FORMAT.ASC': trio['format.asc'], 'Pins.Asc': trio['pins.asc'], 'nails.asc': trio['nails.asc'] } })).toEqual(fromFormat);
    }
    // The entry's own companion copy is ignored, even when it differs.
    expect(must({ ...open(trio, 'pins.asc'), companions: { ...open(trio, 'pins.asc').companions, 'pins.asc': bytes('garbage') } })).toEqual(fromFormat);
  });
  it('names the board after its folder identically for every entry, and accepts paths in companion keys', () => {
    const trio = files();
    const boards = [...ENTRIES.map(entry => must(open(trio, entry, '/boards/X1/'))), must(open(trio, 'nails.asc', 'C:\\boards\\X1\\'))];
    for (const board of boards) expect(board).toEqual(boards[0]);
    expect(boards[0].name).toBe('X1');
    expect(must(open(trio, 'pins.asc', 'C:\\')).name).toBe('format');
    expect(must({ name: 'pins.asc', data: trio['pins.asc'], companions: { 'C:\\x\\format.asc': trio['format.asc'], '/x/nails.asc': trio['nails.asc'] } })).toEqual(must(open(trio, 'format.asc')));
  });
  it('reads the same board as the BDV container of the same records', () => {
    const bdv = parseBdv({ name: 'x.bdv', data: bytes(join(['<<format.asc>>', ...header(8, 'format'), ...FORMAT, '<<pins.asc>>', ...header(8, 'pins'), ...PINS, '<<nails.asc>>', ...header(7, 'nails'), ...NAILS])) })!;
    expect({ ...bdv, name: 'format', format: 'ASC companion trio' }).toEqual(must(open(files(), 'format.asc')));
  });
  it('is independent of line endings and BOMs', () => {
    const golden = must(open(files(), 'format.asc'));
    expect(must(open(files(FORMAT, PINS, NAILS, '\n'), 'pins.asc'))).toEqual(golden);
    expect(must(open(files(FORMAT, PINS, NAILS, '\r'), 'nails.asc'))).toEqual(golden);
    const trio = files();
    expect(must({ ...open(trio, 'format.asc'), data: new Uint8Array([0xef, 0xbb, 0xbf, ...trio['format.asc']]) })).toEqual(golden);
  });
  it('names exactly the missing companions with COMPANIONS_REQUIRED', () => {
    const trio = files();
    const cases: Array<[Entry, Entry[], string]> = [
      ['format.asc', [], 'ASC: the companion files pins.asc and nails.asc are missing.'],
      ['format.asc', ['pins.asc'], 'ASC: the companion file nails.asc is missing.'],
      ['pins.asc', ['nails.asc'], 'ASC: the companion file format.asc is missing.'],
      ['pins.asc', [], 'ASC: the companion files format.asc and nails.asc are missing.'],
      ['nails.asc', ['format.asc'], 'ASC: the companion file pins.asc is missing.'],
    ];
    for (const [entry, given, message] of cases) {
      const error = thrown({ name: entry, data: trio[entry], companions: Object.fromEntries(given.map(name => [name, trio[name]])) });
      expect(error).toMatchObject({ code: 'COMPANIONS_REQUIRED', format: 'ASC companion trio', message });
    }
    expect(thrown({ name: 'format.asc', data: trio['format.asc'] })).toMatchObject({ code: 'COMPANIONS_REQUIRED' });
    expect(thrown({ name: 'format.asc', data: trio['format.asc'], companions: { 'pins.asc': trio['pins.asc'], 'nails.asc.bak': trio['nails.asc'] } }).message).toMatch(/nails\.asc is missing/);
  });
  it('rejects a companion that is given twice with different contents', () => {
    const trio = files();
    const error = thrown({ ...open(trio, 'format.asc'), companions: { 'pins.asc': trio['pins.asc'], 'PINS.ASC': bytes('other'), 'nails.asc': trio['nails.asc'] } });
    expect(error.message).toMatch(/pins\.asc is given twice with different contents/);
    expect(must({ ...open(trio, 'format.asc'), companions: { 'pins.asc': trio['pins.asc'], 'PINS.ASC': trio['pins.asc'].slice(), 'nails.asc': trio['nails.asc'] } }).components).toHaveLength(4);
  });
  it('returns null for names and bytes that are not an ASC entry', () => {
    const trio = files();
    expect(parseAsc({ name: 'board.asc', data: trio['pins.asc'], companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc.bak', data: trio['format.asc'], companions: trio })).toBeNull();
    expect(parseAsc({ name: 'pins.asc', data: bytes('just a README\nwith a few lines\n'), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'pins.asc', data: bytes(join([...header(8, 'x'), 'not a part line'])), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc', data: bytes(join([...header(8, 'x'), 'a b'])), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'nails.asc', data: bytes(join([...header(7, 'x'), '5 1 2'])), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc', data: Uint8Array.from([0, 1, 2, 3, 0, 5]), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc', data: new Uint8Array(0), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc', data: bytes(join(header(3, 'short'))), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'format.asc', data: bytes(join(header(8, 'only'))), companions: trio })).toBeNull();
    expect(parseAsc({ name: 'pins.asc', data: bytes(join(header(8, 'only'))), companions: trio })).toBeNull();
  });
  it('treats empty nails/format companions as absent data, but requires pins', () => {
    const trio = files();
    const noNails = must({ ...open(trio, 'format.asc'), companions: { 'pins.asc': trio['pins.asc'], 'nails.asc': new Uint8Array(0) } });
    expect(noNails.components.map(c => c.ref)).toEqual(['U1', 'R1']);
    const noOutline = must({ ...open(trio, 'pins.asc'), companions: { 'format.asc': new Uint8Array(0), 'nails.asc': trio['nails.asc'] } });
    expect(noOutline.warnings.map(warning => warning.key)).toContain('parse.warning.missingBoardOutline');
    expect(thrown({ ...open(trio, 'format.asc'), companions: { 'pins.asc': new Uint8Array(0), 'nails.asc': trio['nails.asc'] } }).message).toBe('ASC pins.asc: the file contains no component records.');
    expect(must(open(files(FORMAT, PINS, []), 'nails.asc')).components).toHaveLength(2);
    expect(must(open(files(FORMAT, PINS, []), 'nails.asc'))).toEqual(must(open(files(FORMAT, PINS, []), 'format.asc')));
  });
  it('rejects malformed companions naming the file and line', () => {
    const cases: Array<[Trio, Entry, RegExp]> = [
      [files(['0.0']), 'pins.asc', /ASC format\.asc line 9: an outline point needs two coordinates/],
      [files(FORMAT, ['Part U1 (T)', '1 1 0.1 q 1 A 0']), 'nails.asc', /ASC pins\.asc line 10: invalid pin Y "q"/],
      [files(FORMAT, ['1 1 0.1 0.1 1 A 0']), 'format.asc', /ASC pins\.asc line 9: a pin record appears before the first Part line/],
      [files(FORMAT, PINS, ['*5 0.1 0.2 1 G (T) 11']), 'pins.asc', /ASC nails\.asc line 8: a test point needs probe/],
      [files(FORMAT, PINS, ['5 0.1 0.2 1 G1 (T) 11 VCC']), 'format.asc', /ASC nails\.asc line 8: a test point starts with a marker character/],
    ];
    for (const [trio, entry, pattern] of cases) {
      const error = thrown(open(trio, entry));
      expect(error.message).toMatch(pattern);
      expect(error).toMatchObject({ code: 'INVALID_FORMAT', format: 'ASC companion trio' });
    }
    const truncated = files();
    expect(thrown({ ...open(truncated, 'format.asc'), companions: { 'pins.asc': truncated['pins.asc'], 'nails.asc': bytes(join(header(4, 'n'))) } }).message)
      .toMatch(/ASC nails\.asc: the file is shorter than its 7 header lines/);
    expect(thrown({ ...open(truncated, 'format.asc'), companions: { 'pins.asc': bytes(join(header(2, 'p'))), 'nails.asc': truncated['nails.asc'] } }).message)
      .toMatch(/ASC pins\.asc: the file is shorter than its 8 header lines/);
  });
  it('discloses omitted pinless components and repeated references like the other text adapters', () => {
    const board = must(open(files(FORMAT, ['Part E1 (T)', 'Part U1 (T)', '1 1 0.1 0.1 1 A 0', 'Part U1 (B)', '1 1 0.2 0.1 1 A 0'], []), 'format.asc'));
    expect(board.components.map(c => [c.ref, c.side])).toEqual([['U1', 'top'], ['U1', 'bottom']]);
    expect(notes(board)).toEqual([
      '1 component without pins was omitted because the file gives no position for it.',
      '1 component reuses a reference designator that another component already has; all are kept as separate components.',
    ]);
  });
  it('keeps the format name on errors raised by the shared board builder', () => {
    const error = thrown(open(files(['0 0', '1e12 0', '0 1']), 'pins.asc'));
    expect(error.message).toMatch(/exceeds the supported range/);
    expect(error).toMatchObject({ format: 'ASC companion trio', code: 'INVALID_FORMAT' });
  });
  it('bounds a single line', () => {
    const trio = files(['0 ' + '1'.repeat(4_194_305)]);
    expect(thrown(open(trio, 'pins.asc'))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
  it('turns every truncation of any of the three files, as entry or as companion, into a board, null or a BoardFormatError', () => {
    const trio = files();
    let boards = 0, failures = 0, nulls = 0;
    for (const target of ENTRIES) {
      for (let length = 0; length <= trio[target].length; length++) {
        for (const entry of ENTRIES) {
          const cut = { ...trio, [target]: trio[target].slice(0, length) };
          try {
            if (parseAsc(open(cut, entry))) boards++; else nulls++;
          } catch (error) {
            expect(error, `${entry} with ${target} cut at ${length}`).toBeInstanceOf(BoardFormatError);
            failures++;
          }
        }
      }
    }
    expect(boards).toBeGreaterThan(0); expect(failures).toBeGreaterThan(0); expect(nulls).toBeGreaterThan(0);
  });
});
