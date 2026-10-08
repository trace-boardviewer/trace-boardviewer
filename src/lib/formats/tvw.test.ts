import { describe, expect, it } from 'vitest';
import { parseTvw, hasTvwNetTable, isAppleDouble } from './tvw';
import { syntheticTvw } from './adapters/tvw/fixtures';
import tvwAdapter from './adapters/tvw';
import { BoardFormatError } from './common';
import { parseBoardDetailed } from './dispatch';
import { expectScaling } from '../../test-support/timing';

const read = (data = syntheticTvw()) => parseTvw({ name: 'test.tvw', data })!;
describe('original TVW reader', () => {
  it('registers and opens structured bytes, including a renamed file', () => {
    expect(parseBoardDetailed({ name: 'test.tvw', data: syntheticTvw() }).adapter).toBe('tvw');
    expect(parseBoardDetailed({ name: 'renamed.bin', data: syntheticTvw() }).adapter).toBe('tvw');
    expect(hasTvwNetTable(syntheticTvw())).toBe(true);
  });
  it('maps serialized pin order with sparse ordinals, rotates and converts centimils', () => {
    const board = read();
    expect(board.components).toHaveLength(1);
    expect(board.pins).toHaveLength(4);
    expect(board.components[0].ref).toBe('U1');
    expect(board.pins.map(pin => pin.number)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(board.pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
    expect(board.pins[0].x).toBeCloseTo(19000 * 0.000254);
    expect(board.pins[0].y).toBeCloseTo(11000 * 0.000254);
    expect(board.pins.every(pin => pin.side === 'top')).toBe(true);
    expect(board.warnings?.find(issue => issue.key === 'parse.warning.tvwSummary')?.params).toEqual({ mapped: 4, unresolved: 0, omitted: 0 });
  });
  it('reads the metadata variant containing a height word', () => {
    expect(read(syntheticTvw({ oldMetadata: true, rotation: 180 })).pins).toHaveLength(4);
  });
  it('keeps the BOM value when two extra Pascal fields follow it', () => {
    const board = read(syntheticTvw({ extraMetadata: true }));
    expect(board.components[0].value).toBe('SYNTHETIC');
    expect(board.components[0].package).toBe('TEST4');
    expect(board.pins).toHaveLength(4);
  });
  it('uses the explicitly indexed bottom geometry without mirroring it twice', () => {
    const board = read(syntheticTvw({ masterName: 'TEST4_B', pinKind: 7,
      masterPoints: [{ x: 2000, y: 1000 }, { x: -2000, y: 1000 }, { x: -2000, y: -1000 }, { x: 2000, y: -1000 }] }));
    expect(board.components[0].side).toBe('bottom');
    expect(board.pins.every(pin => pin.side === 'bottom')).toBe(true);
    expect(board.pins[0].x).toBeCloseTo(21000 * 0.000254);
    expect(board.pins[0].y).toBeCloseTo(8000 * 0.000254);
  });
  it.each([2, 5, 7])('uses the declared pad namespace of pin-group kind %i', pinKind => {
    const board = read(syntheticTvw({ pinKind }));
    expect(board.pins).toHaveLength(4);
    expect(board.components[0].side).toBe(pinKind === 2 ? 'top' : 'bottom');
  });
  it('accepts the unknown classification marker without guessing component type', () => {
    expect(read(syntheticTvw({ classification: 0xffffffff })).pins).toHaveLength(4);
  });
  it('uses indexed pads rather than nearby pads with conflicting nets', () => {
    const board = read(syntheticTvw({ conflictingPads: true }));
    expect(board.pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
  });
  it('gets the board side from the declared layer, never from opaque pad flags', () => {
    expect(read(syntheticTvw({ padLayerTag: 5 })).pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
    expect(read(syntheticTvw({ padLayerTag: 5, conflictingPads: true })).pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
    expect(read(syntheticTvw({ padLayerTag: 6 })).pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
    expect(read(syntheticTvw({ oppositeSidePads: true })).pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
  });
  it('does not depend on footprint naming or accept duplicate ordinals', () => {
    expect(read(syntheticTvw({ masterName: 'OTHER' })).pins).toHaveLength(4);
    expect(read(syntheticTvw({ omitMaster: true })).pins).toHaveLength(4);
    expect(() => read(syntheticTvw({ ordinals: [1, 1, 2, 3] }))).toThrow(/unsupported or incomplete record/);
  });
  it('keeps pin labels attached to their UID even when master order differs', () => {
    const board = read(syntheticTvw({ uids: [24, 16, 8, 0] }));
    expect(board.pins.map(pin => pin.number)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(board.pins.map(pin => pin.net)).toEqual(['VCC', 'GND', 'VCC', 'GND']);
    expect(board.pins[0].x).toBeCloseTo(21000 * 0.000254);
    expect(board.pins[0].y).toBeCloseTo(11000 * 0.000254);
    expect(board.pins[0].width).toBeCloseTo(600 * 0.000254);
    expect(board.pins[0].height).toBeCloseTo(400 * 0.000254);
  });
  it('imports unnamed test points with generated identity and the explicit bottom pad link', () => {
    const board = read(syntheticTvw({ testPoint: true, pinKind: 5 }));
    expect(board.pins).toHaveLength(1);
    expect(board.pins[0]).toMatchObject({ number: '1', numberGenerated: true, net: 'GND', side: 'bottom' });
    expect(board.components[0].side).toBe('bottom');
  });
  it('refuses misaligned or out-of-range pad references', () => {
    for (const uids of [[1, 8, 16, 24], [32, 8, 16, 24]]) expect(() => read(syntheticTvw({ uids }))).toThrow(/pin reference/);
  });
  it('never assigns a net from invalid D-code pad records', () => {
    expect(() => read(syntheticTvw({ corruptDcode: true }))).toThrow(/physical layer tables/);
  });
  describe('export variants documented as record facts', () => {
    // A layer list with the TOP header at index 2 and the BOTTOM header at 13: the pin list names the layer by that index.
    const aux = [3, 3, 'top', 4, 5, 3, 4, 5, 3, 4, 5, 3, 4, 'bottom'] as Array<'top' | 'bottom' | number>;
    const nets = (data: Uint8Array) => read(data).pins.map(pin => pin.net);
    it('takes the layer from the zero-based index into the full header list and the side from the header type', () => {
      const top = read(syntheticTvw({ layerList: aux, pinKind: 2 })), bottom = read(syntheticTvw({ layerList: aux, pinKind: 13 }));
      expect(top.pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
      expect(top.pins.every(pin => pin.side === 'top') && top.components[0].side === 'top').toBe(true);
      expect(bottom.pins.map(pin => pin.net)).toEqual(['VCC', 'GND', 'VCC', 'GND']);
      expect(bottom.pins.every(pin => pin.side === 'bottom') && bottom.components[0].side === 'bottom').toBe(true);
    });
    it('counts aux, silk, mask and inner headers in the index, so the first bottom layer can sit at 5 or 7', () => {
      for (const list of [[3, 4, 'top', 3, 4, 'bottom'], [3, 4, 'top', 3, 4, 5, 3, 'bottom']] as Array<Array<'top' | 'bottom' | number>>) {
        const index = list.indexOf('bottom');
        expect(nets(syntheticTvw({ layerList: list, pinKind: index }))).toEqual(['VCC', 'GND', 'VCC', 'GND']);
        expect(nets(syntheticTvw({ layerList: list, pinKind: 2 }))).toEqual(['GND', 'VCC', 'GND', 'VCC']);
      }
    });
    it('resolves a layer only through its own header: another top and bottom order is followed, not assumed', () => {
      const reversed = ['bottom', 3, 'top'] as Array<'top' | 'bottom' | number>;
      expect(nets(syntheticTvw({ layerList: reversed, pinKind: 0 }))).toEqual(['VCC', 'GND', 'VCC', 'GND']);
      expect(read(syntheticTvw({ layerList: reversed, pinKind: 0 })).pins[0].side).toBe('bottom');
    });
    it('never turns an unknown or non-copper layer number into TOP or BOTTOM', () => {
      expect(() => read(syntheticTvw({ layerList: aux, pinKind: 4 }))).toThrow(/names layer 4, which is not a top or bottom layer/);
      expect(() => read(syntheticTvw({ layerList: aux, pinKind: 14 }))).toThrow(/names layer 14/);
      expect(() => read(syntheticTvw({ layerList: aux, pinKind: 13000 }))).toThrow(/unsupported or incomplete record/);
    });
    it('keeps the first established numbers 2, 5 and 7 when the header list does not name them', () => {
      expect(read(syntheticTvw({ pinKind: 2 })).pins.every(pin => pin.side === 'top')).toBe(true);
      for (const pinKind of [5, 7]) expect(read(syntheticTvw({ pinKind })).pins.every(pin => pin.side === 'bottom')).toBe(true);
    });
    it.each([35, 0x17])('accepts the net-table closing word with low byte %i', closingTag => {
      expect(hasTvwNetTable(syntheticTvw({ closingTag }))).toBe(true);
      expect(read(syntheticTvw({ closingTag })).pins).toHaveLength(4);
    });
    it('does not accept an unknown closing byte, so a coincidental text fragment is no table', () => {
      for (const closingTag of [0, 0x20, 0x2e, 0x24, 0x16, 0x18, 0xff]) {
        const data = syntheticTvw({ closingTag });
        expect(hasTvwNetTable(data)).toBe(false);
        expect(parseTvw({ name: 'test.tvw', data })).toBeNull();
      }
    });
    it.each([0, 24, 41, 69, 70, 83, 4096])('finds the net table without the fixed 69-byte prefix (prefix of %i bytes)', netPrefix => {
      const data = syntheticTvw({ netPrefix });
      expect(hasTvwNetTable(data)).toBe(true);
      const board = read(data);
      expect(board.pins.map(pin => pin.net)).toEqual(['GND', 'VCC', 'GND', 'VCC']);
      expect(board.pins.map(pin => pin.number)).toEqual(['P1', 'P2', 'P3', 'P4']);
      expect(read(syntheticTvw({ netPrefix, closingTag: 0x17, layerList: aux, pinKind: 13 })).pins.every(pin => pin.side === 'bottom')).toBe(true);
    });
    it('searches for a table without the prefix in linear time, even in data full of candidate count pairs', () => {
      const block = Uint8Array.from([3, 0, 0, 0, 3, 0, 0, 0, 1, 65, 1, 66, 1, 67, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 7, 80, 114, 111, 98, 101, 68, 66, 0]);
      expectScaling('TVW net-table search', [64 * 1024, 256 * 1024, 1024 * 1024], size => {
        const data = new Uint8Array(size);
        for (let at = 0; at + block.length <= size; at += 3) data.set(block, at);
        return () => { expect(parseTvw({ name: 'junk.tvw', data })).toBeNull(); };
      });
    });
    it('rejects a layer-header prefix variant it does not know with a precise error, never an empty board', () => {
      let error: unknown;
      try { read(syntheticTvw({ layerPrefixWord: 5 })); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(BoardFormatError);
      expect((error as BoardFormatError).code).toBe('UNSUPPORTED_VARIANT');
      expect((error as BoardFormatError).message).toMatch(/layer-header variant that is not supported/);
    });
    it('refuses an AppleDouble companion file with a clear error and still reads a real file whose name starts with "._"', () => {
      const appleDouble = Uint8Array.from([0, 5, 0x16, 7, 0, 2, 0, 0, ...new Uint8Array(16), 0, 0, 0, 2, 0, 0, 0, 38, 0, 0, 0, 32, 0, 0, 0, 9, 0, 0, 0, 70, 0, 0, 0, 0]);
      expect(isAppleDouble(appleDouble)).toBe(true);
      expect(isAppleDouble(syntheticTvw())).toBe(false);
      expect(isAppleDouble(appleDouble.subarray(0, 7))).toBe(false);
      for (const name of ['._board.tvw', 'board.tvw']) {
        expect(() => parseTvw({ name, data: appleDouble })).toThrow(/AppleDouble companion file/);
        expect(() => parseBoardDetailed({ name, data: appleDouble })).toThrow(/AppleDouble companion file/);
      }
      expect(tvwAdapter.sniff({ head: appleDouble, name: '._board.tvw', size: appleDouble.length }).confidence).toBeGreaterThanOrEqual(50);
      expect(tvwAdapter.sniff({ head: appleDouble, name: 'notes.txt', size: appleDouble.length }).confidence).toBe(0);
      expect(parseBoardDetailed({ name: '._board.tvw', data: syntheticTvw() }).board.pins).toHaveLength(4);
    });
  });
  it('supports Uint8Array subviews and rejects incomplete table markers', () => {
    const original = syntheticTvw(), padded = new Uint8Array(original.length + 11); padded.set(original, 7);
    expect(read(padded.subarray(7, 7 + original.length)).pins).toHaveLength(4);
    const damaged = original.slice();
    const marker = new TextEncoder().encode('ProbeDB');
    let found = -1;
    for (let p = 0; p < damaged.length - marker.length; p++) if (marker.every((byte, i) => damaged[p + i] === byte)) { found = p; break; }
    damaged[found + marker.length] = 0;
    expect(parseTvw({ name: 'test.tvw', data: damaged })).toBeNull();
    expect(parseTvw({ name: 'test.tvw', data: new Uint8Array(256) })).toBeNull();
  });
});
