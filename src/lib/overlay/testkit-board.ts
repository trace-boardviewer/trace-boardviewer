import type { Bounds2, Point2 } from '../geometry';
import type { Board, BoardComponent, BoardPin } from '../types';
import { type Matrix3, transform } from './matrix3';
import type { Rng } from './testkit';
import type { ThermalGrid } from './thermal';

/** A toy board and a toy thermal picture for the thermal, damage and right-file tests. Nothing here is used by the application. */

export interface ToyBoardOptions {
  columns?: number;
  rows?: number;
  /** Distance between part centres, millimetres. */
  pitchX?: number;
  pitchY?: number;
  /** Size of a part, millimetres. */
  width?: number;
  height?: number;
  side?: 'top' | 'bottom';
  /** Net of pin 1 of the part at (column, row); default `S{column}_{row}`. Pin 2 is always on GND. */
  netOf?: (column: number, row: number) => string;
}

export interface ToyBoard extends Pick<Board, 'components' | 'pins'> {
  readonly bounds: Bounds2;
  /** Centre of the part in a column and row. */
  centre: (column: number, row: number) => Point2;
  refOf: (column: number, row: number) => string;
}

/** A regular array of two-pin parts centred on the origin: part `R{column}_{row}`, pin 1 on a net of its own and pin 2 on GND. */
export function makeToyBoard(options: ToyBoardOptions = {}): ToyBoard {
  const columns = options.columns ?? 10, rows = options.rows ?? 6, pitchX = options.pitchX ?? 8, pitchY = options.pitchY ?? 8;
  const width = options.width ?? 4, height = options.height ?? 2, side = options.side ?? 'top';
  const centre = (column: number, row: number): Point2 => ({ x: (column - (columns - 1) / 2) * pitchX, y: (row - (rows - 1) / 2) * pitchY });
  const refOf = (column: number, row: number) => `R${column}_${row}`;
  const components: BoardComponent[] = [], pins: BoardPin[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const c = centre(column, row), id = `c${row * columns + column}`;
    const pinIds = [`${id}p1`, `${id}p2`];
    components.push({
      id, ref: refOf(column, row), value: '10k', package: '0805', side, bounds: { minX: c.x - width / 2, minY: c.y - height / 2, maxX: c.x + width / 2, maxY: c.y + height / 2 }, position: c, rotation: 0, pinIds,
      outline: [],
    });
    pins.push(
      { id: pinIds[0], componentId: id, number: '1', name: '1', net: options.netOf ? options.netOf(column, row) : `S${column}_${row}`, side, x: c.x - width / 2 + 0.5, y: c.y, radius: 0.4, shape: 'round' },
      { id: pinIds[1], componentId: id, number: '2', name: '2', net: 'GND', side, x: c.x + width / 2 - 0.5, y: c.y, radius: 0.4, shape: 'round' },
    );
  }
  const bounds = { minX: centre(0, 0).x - width / 2, minY: centre(0, 0).y - height / 2, maxX: centre(columns - 1, rows - 1).x + width / 2, maxY: centre(columns - 1, rows - 1).y + height / 2 };
  return { components, pins, bounds, centre, refOf };
}

export interface HeatSource { at: Point2; /** Peak rise over the background, degrees. */ rise: number; /** Standard deviation of the spot on the board, millimetres. */ sigmaMm: number }

/**
 * A thermal picture of the board as a camera sees it: every cell gets the background plus the Gaussian spots at the BOARD positions the cell looks at
 * (computed through the true map, so the picture does not depend on the registration under test) plus noise.
 */
export function makeThermalGrid(width: number, height: number, imageToBoard: Matrix3, sources: readonly HeatSource[], rng: Rng, options: { background?: number; noise?: number } = {}): ThermalGrid {
  const values = new Float32Array(width * height), background = options.background ?? 25, noise = options.noise ?? 0.05;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const p = transform(imageToBoard, { x: i + 0.5, y: j + 0.5 });
    let v = background + noise * rng.gaussian();
    if (p) for (const s of sources) v += s.rise * Math.exp(-((p.x - s.at.x) ** 2 + (p.y - s.at.y) ** 2) / (2 * s.sigmaMm * s.sigmaMm));
    values[j * width + i] = v;
  }
  return { width, height, values, unit: 'celsius' };
}
