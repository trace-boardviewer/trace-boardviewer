import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parseBoardDetailed } from '../../src/lib/formats/dispatch';

const require = createRequire(import.meta.url);
const { boardText } = require('./workspaces.cjs') as { boardText: () => string };

describe('packaged workspace board fixture', () => {
  it('decodes through the registered GenCAD adapter with known component and pad geometry', () => {
    const data = new TextEncoder().encode(boardText());
    const decoded = parseBoardDetailed({ name: 'Board.cad', data });
    expect(decoded.adapter).toBe('gencad');
    expect(decoded.board.components.map(({ ref }) => ref)).toEqual(['U1']);
    expect(decoded.board.pins).toHaveLength(2);
    expect(decoded.board.pins.map(({ number }) => number).sort()).toEqual(['1', '2']);
    const pins = decoded.board.pins.slice().sort((a, b) => a.x - b.x);
    expect(pins[0].x).toBeCloseTo(19, 5);
    expect(pins[1].x).toBeCloseTo(21, 5);
    expect(pins[0].y).toBeCloseTo(pins[1].y, 5);
  });
});
