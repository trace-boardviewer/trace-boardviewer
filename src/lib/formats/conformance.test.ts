/*
 * Conformance kit: the rules every registered adapter must pass (docs/ADAPTERS.md). New adapters are covered as soon as
 * their folder exists; their fixtures.ts feeds the sample-based checks.
 */
import { describe, expect, it } from 'vitest';
import { GenCadParseError } from '../gencad';
import { expectScaling } from '../../test-support/timing';
import type { Board } from '../types';
import { SNIFF_BYTES, type BoardAdapter, type FormatAdapter, type SniffInput } from './adapter';
import { BoardFormatError, TextDecodeError, type ParseInput } from './common';
import { sniffInputOf } from './dispatch';
import type { AdapterFixture } from './fixture';
import { parseWith } from './index';
import { BOARD_ADAPTERS, CONTAINER_ADAPTERS } from './registry';

const FIXTURES = Object.entries(import.meta.glob<AdapterFixture[]>('./adapters/*/fixtures.ts', { eager: true, import: 'default' }))
  .flatMap(([file, list]) => list.map(fixture => ({ owner: /adapters\/([^/]+)\/fixtures\.ts$/.exec(file)![1], fixture })));
const inputOf = (fixture: AdapterFixture, data = fixture.data): ParseInput => ({ name: fixture.name, data, ...(fixture.companions ? { companions: { ...fixture.companions } } : {}), ...(fixture.options ? { options: fixture.options } : {}) });
const encoder = new TextEncoder();
const repeat = (unit: string, bytes = SNIFF_BYTES) => encoder.encode(unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)).subarray(0, bytes);
function prng(seed: number) { let state = seed >>> 0 || 1; return () => (state = (state ^ state << 13) >>> 0, state = (state ^ state >>> 17) >>> 0, state = (state ^ state << 5) >>> 0, state / 2 ** 32); }
const random = prng(0xadab7e2);
const noise = (length: number, next = random) => Uint8Array.from({ length }, () => Math.floor(next() * 256));
/** Floods of `size` bytes of the characters and shapes the sniffs look for, chosen to break naive scanners. */
const floods = (size: number, next = random): Array<[string, Uint8Array]> => [
  ['zeros', new Uint8Array(size)], ['0xFF', new Uint8Array(size).fill(0xff)], ['noise', noise(size, next)],
  ['newlines', repeat('\n', size)], ['CRs', repeat('\r', size)], ['blanks', repeat(' ', size)], ['tabs and blanks', repeat('\t ', size)], ['line separators', repeat('\u2028', size)], ['comment lines', repeat(';\n', size)],
  ['open comments', repeat('<!--', size)], ['dashes', repeat('-', size)], ['open tags', repeat('<', size)], ['parentheses', repeat('(', size)], ['pipes', repeat('|RECORD=', size)], ['dollars', repeat('$HEADER', size)],
  ['Gerber statements', repeat('%FSLAX24Y24*%', size)], ['BVR prefixes', repeat('BVRAW_FORMAT_', size)], ['BVR digits', encoder.encode('BVRAW_FORMAT_' + '9'.repeat(Math.max(0, size - 13))).subarray(0, size)],
  ['BDV markers', repeat('<<format.asc>>', size)], ['Samsung markers', repeat('###Panel Added C_PIN ', size)], ['BRD lines', repeat('str_length:\nvar_data:\n', size)], ['hashes', repeat('# file :\n', size)],
  ['lone continuation bytes', repeat('\x80', size)],
];
/** Heads chosen to break naive scanners: empty, binary, byte-order marks, floods of the characters the sniffs look for. */
const HOSTILE: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)], ['one NUL', new Uint8Array(1)],
  ['UTF-16 LE mark only', Uint8Array.from([0xff, 0xfe])], ['UTF-16 BE mark and an odd byte', Uint8Array.from([0xfe, 0xff, 0x41])], ['UTF-8 BOM only', Uint8Array.from([0xef, 0xbb, 0xbf])],
  ['truncated UTF-8 sequence', Uint8Array.from([0x41, 0xe2, 0x80])],
  ...floods(SNIFF_BYTES),
];
const NAMES = ['board.brd', 'board.cad', 'format.asc', 'x.fz', 'x.bin', '', 'C:\\dir\\pins.asc', 'archive/nails.asc'];

describe('conformance: every sniff is total, bounded and honest', () => {
  it.each([...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(adapter => [adapter.id, adapter] as const))('%s', (_id, adapter: FormatAdapter) => {
    for (const [label, head] of HOSTILE) {
      for (const name of NAMES) for (const size of [head.length, head.length + 1, 64 * 1024 * 1024]) {
        const input: SniffInput = { head, name, size };
        let result;
        try { result = adapter.sniff(input); } catch (error) { throw new Error(`${adapter.id}: sniff threw on "${label}" (${name}): ${String(error)}`); }
        expect(Number.isInteger(result.confidence) && result.confidence >= 0 && result.confidence <= 100, `${label}: confidence ${result.confidence}`).toBe(true);
        expect(result.reason.length > 0, `${label}: a reason exactly when confidence > 0`).toBe(result.confidence > 0);
        expect(adapter.sniff(input), `${label}: deterministic`).toEqual(result);
      }
    }
  });
  // A sniff is linear in the head. The floods are sniffed at growing sizes and the running time may grow at most like size^1.7 (a quadratic
  // scan grows like size^2); the sizes are compared with each other in the same process, so a busy machine does not decide the outcome.
  it.each([...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS].map(adapter => [adapter.id, adapter] as const))('%s: the sniff time is linear in the head', (_id, adapter: FormatAdapter) => {
    expectScaling(`${adapter.id} sniffing floods`, [SNIFF_BYTES / 16, SNIFF_BYTES / 4, SNIFF_BYTES], size => {
      const heads = floods(size, prng(0xf100d + size));
      return () => { for (const [, head] of heads) for (const name of NAMES) for (const extra of [0, 1]) adapter.sniff({ head, name, size: head.length + extra }); };
    });
  });
  it('never looks past the head it is given (the same verdict on a copy that owns no further bytes)', () => {
    for (const { fixture } of FIXTURES) {
      const input = sniffInputOf(inputOf(fixture));
      const padded = new Uint8Array(input.head.length + 16).fill(0x41);
      padded.set(input.head);
      const view: SniffInput = { ...input, head: padded.subarray(0, input.head.length) };
      for (const adapter of [...BOARD_ADAPTERS, ...CONTAINER_ADAPTERS]) expect(adapter.sniff(view), `${adapter.id} on ${fixture.label}`).toEqual(adapter.sniff({ ...input, head: input.head.slice() }));
    }
  });
});

describe('conformance: sniffs see claims beyond the window and on cut files', () => {
  const siblingsSee = (adapter: BoardAdapter, input: ParseInput) => BOARD_ADAPTERS.filter(other => other.parse === adapter.parse).some(other => other.sniff(sniffInputOf(input)).confidence > 0);
  function claims(adapter: BoardAdapter, input: ParseInput): boolean {
    try { return parseWith(adapter, input) !== null; }
    catch (error) { if (error instanceof TextDecodeError) return false; if (error instanceof BoardFormatError || error instanceof GenCadParseError) return true; throw error; }
  }
  const variants = (data: Uint8Array): Array<[string, Uint8Array]> => {
    const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
    const out: Array<[string, Uint8Array]> = [['as is', data], ['70 KiB of trailing blank lines', join(data, repeat('\n', 70 * 1024))], ['70 KiB of leading blank lines', join(repeat('\n', 70 * 1024), data)],
      ['70 KiB of leading blanks', join(repeat(' ', 70 * 1024), data)], ['70 KiB of leading comment lines', join(repeat('; c\n', 70 * 1024), data)]];
    for (const cut of [1, 4, 8, 16, 64, Math.floor(data.length / 2), data.length - 1]) if (cut > 0 && cut < data.length) out.push([`first ${cut} bytes`, data.subarray(0, cut)]);
    return out;
  };
  it.each(FIXTURES.map(({ owner, fixture }) => [`${owner}: ${fixture.label}`, fixture] as const))('%s', (_label, fixture) => {
    for (const [variant, data] of variants(fixture.data)) {
      const input = inputOf(fixture, data);
      for (const adapter of BOARD_ADAPTERS) if (claims(adapter, input)) expect(siblingsSee(adapter, input), `${adapter.id} claims "${variant}" but no sniff of its reader sees it`).toBe(true);
    }
  });
});

describe('conformance: what every reader returns', () => {
  const valid = (board: Board) => {
    expect(board.units).toBe('mm');
    const components = new Set(board.components.map(component => component.id)), pins = new Set(board.pins.map(pin => pin.id));
    for (const component of board.components) expect(['top', 'bottom', 'both']).toContain(component.side);
    for (const pin of board.pins) {
      expect(['top', 'bottom', 'both']).toContain(pin.side);
      expect(Number.isFinite(pin.x) && Number.isFinite(pin.y)).toBe(true);
      expect(components.has(pin.componentId)).toBe(true);
    }
    for (const net of board.nets) for (const id of net.pinIds) expect(pins.has(id)).toBe(true);
  };
  it.each(FIXTURES.filter(({ owner, fixture }) => fixture.expect !== 'refused' && BOARD_ADAPTERS.some(adapter => adapter.id === owner)).map(({ owner, fixture }) => [`${owner}: ${fixture.label}`, owner, fixture] as const))('%s: canonical and deterministic', (_label, owner, fixture) => {
    const adapter = BOARD_ADAPTERS.find(candidate => candidate.id === owner)!;
    const first = parseWith(adapter, inputOf(fixture)), second = parseWith(adapter, inputOf(fixture));
    expect(first).not.toBeNull();
    valid(first!);
    expect(second).toEqual(first);
  });
  it('a parse fails only with a format error on hostile input', () => {
    for (const adapter of BOARD_ADAPTERS) for (const [label, data] of HOSTILE) for (const name of ['board.brd', 'x.fz', 'format.asc']) {
      try { parseWith(adapter, { name, data }); }
      catch (error) { expect(error instanceof BoardFormatError || error instanceof GenCadParseError || error instanceof TextDecodeError, `${adapter.id} on ${label} (${name}): ${String(error)}`).toBe(true); }
    }
  });
});
