import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import gencad from './formats/adapters/gencad/fixtures';
import { BoardFormatError } from './formats/common';
import { parseBoardDetailed } from './formats/dispatch';

const source = gencad[0].data;

describe('stable import boundary', () => {
  it('keeps caller-owned ZIP bytes intact and turns every one-byte archive mutation into a bounded import result', () => {
    const sourceSnapshot = source.slice();
    const archive = zipSync({ 'synthetic/board.cad': source });
    const original = archive.slice();
    const opened = parseBoardDetailed({ name: 'synthetic.zip', data: archive });

    expect(opened).toMatchObject({ adapter: 'gencad', container: 'zip', entry: 'synthetic/board.cad' });
    expect(archive).toEqual(original);
    expect(opened.board.components.every(component => Boolean(component.ref))).toBe(true);
    expect(opened.board.pins.every(pin => Number.isFinite(pin.x) && Number.isFinite(pin.y))).toBe(true);

    for (let index = 0; index < archive.length; index++) {
      const damaged = original.slice();
      damaged[index] ^= 0x80;
      try {
        const result = parseBoardDetailed({ name: 'synthetic.zip', data: damaged });
        expect(result.adapter, `mutation at byte ${index}`).toBe('gencad');
        expect(result.board.components.every(component => Boolean(component.ref)), `mutation at byte ${index}`).toBe(true);
        expect(result.board.pins.every(pin => Number.isFinite(pin.x) && Number.isFinite(pin.y)), `mutation at byte ${index}`).toBe(true);
      } catch (error) {
        expect(error, `mutation at byte ${index}`).toBeInstanceOf(BoardFormatError);
      }
    }
    expect(archive).toEqual(original);
    expect(source).toEqual(sourceSnapshot);
  });
});
