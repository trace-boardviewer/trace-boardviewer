/** Original synthetic native database generator. Nothing here comes from an input board. */
export interface AllegroFixtureOptions {
  version?: 160 | 162 | 164 | 165 | 166 | 172 | 174 | 175;
  bottom?: boolean;
  rotation?: number;
  padRotation?: number;
  divisor?: number;
  mechanical?: boolean;
  unnamedPad?: boolean;
  throughHole?: boolean;
  holeOnly?: boolean;
}
export function makeAllegro(options: AllegroFixtureOptions = {}): { data: Uint8Array; offsets: Record<string, number> } {
  const version = options.version ?? 166, modern = version >= 172, latest = version >= 174;
  const strings = ['U1', '1', '2', 'GND', 'SIGNAL_A', 'SYNTHETIC_PACKAGE', '10k'];
  const pieces: Uint8Array[] = [], offsets: Record<string, number> = {};
  let offset = 0x1200, objectCount = strings.length;
  const add = (name: string, tag: number, key: number, size: number, fill: (view: DataView, bytes: Uint8Array) => void) => {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    bytes[0] = tag; view.setUint32(4, key, true); fill(view, bytes); offsets[name] = offset;
    offset += size; objectCount++; pieces.push(bytes);
  };
  for (let n = 0; n < strings.length; n++) {
    const text = new TextEncoder().encode(strings[n]), bytes = new Uint8Array(4 + Math.ceil((text.length + 1) / 4) * 4);
    new DataView(bytes.buffer).setUint32(0, 100 + n, true); bytes.set(text, 4); pieces.push(bytes); offsets[`string${n}`] = offset; offset += bytes.length;
  }
  const write = (view: DataView, at: number, value: number) => view.setInt32(at, value, true);
  add('definition', 43, 9, 68 + (version >= 164 ? 4 : 0) + (modern ? 4 : 0), view => { write(view, 8, 105); write(view, 36, 1); });
  add('component', 45, 1, modern ? 72 : 64, (view, bytes) => {
    bytes[2] = options.bottom ? 1 : 0;
    if (!options.mechanical) write(view, modern ? 40 : 12, 2);
    write(view, modern ? 28 : 24, (options.rotation ?? 90) * 1000);
    write(view, modern ? 32 : 28, 10_000); write(view, modern ? 36 : 32, 20_000);
    write(view, modern ? 48 : 40, 5); write(view, modern ? 52 : 44, 30);
  });
  add('reference', 7, 2, modern ? 48 : 40, view => { write(view, modern ? 24 : 12, 1); write(view, modern ? 28 : 20, 100); });
  const layerCount = options.holeOnly ? 0 : 2, fixed = modern ? 21 : version >= 165 ? 11 : 10, header = modern ? 192 : version >= 165 ? 88 : 84, width = modern ? 36 : 28;
  add('stack', 28, 3, header + (fixed + layerCount * (modern ? 4 : 3)) * width - (modern ? 0 : 4), (view, bytes) => {
    view.setUint16(modern ? 44 : 50, layerCount, true);
    if (options.holeOnly || options.throughHole) write(view, modern ? 64 : 16, 80);
    if (modern) bytes[28] = options.throughHole || options.holeOnly ? 0 : 0x20;
    else view.setUint16(44, options.throughHole || options.holeOnly ? 0 : 2, true);
    for (let layer = 0; layer < layerCount; layer++) {
      const at = header + (fixed + layer * (modern ? 4 : 3) + 2) * width;
      bytes[at] = options.throughHole || layer === (options.bottom ? 1 : 0) ? 6 : 0;
      write(view, at + (modern ? 8 : 4), 200); write(view, at + (modern ? 12 : 8), 100);
    }
  });
  for (let n = 0; n < 2; n++) {
    add(`geometry${n}`, 13, 4 + n * 10, 40 + (modern ? 4 : 0) + (latest ? 4 : 0), view => {
      write(view, 16 + (latest ? 4 : 0), 1000 + n * 2000); write(view, 20 + (latest ? 4 : 0), 2000);
      write(view, 24 + (latest ? 4 : 0), 3); write(view, 36 + (modern ? 4 : 0) + (latest ? 4 : 0), (options.padRotation ?? 30) * 1000);
    });
    add(`pad${n}`, 50, 5 + n * 10, modern ? 84 : 76, view => {
      const shift = modern ? 4 : 0;
      write(view, 12, 6 + n * 10); write(view, 20 + shift, n ? 1 : 15); write(view, 24 + shift, 1); write(view, 32 + shift, 4 + n * 10);
      if (!options.unnamedPad) write(view, 44 + shift, 7 + n * 10);
      // Deliberately unrelated bounding box: the reader must use the local geometry.
      write(view, 60 + shift * 2, -900_000); write(view, 64 + shift * 2, -800_000);
    });
    add(`assignment${n}`, 4, 6 + n * 10, latest ? 24 : 20, view => { write(view, 12, 8 + n * 10); write(view, 16, 5 + n * 10); });
    add(`number${n}`, 8, 7 + n * 10, modern ? 32 : 24, view => write(view, modern ? 16 : 8, 101 + n));
    add(`net${n}`, 27, 8 + n * 10, modern ? 60 : 56, view => write(view, 12, 103 + n));
  }
  add('text', 48, 30, 44 + (modern ? 12 : 0) + (latest ? 4 : 0), (view, bytes) => { bytes[2] = 2; write(view, 8, 1); write(view, (modern ? 28 : 12) + (latest ? 4 : 0), 31); });
  add('value', 49, 31, (latest ? 28 : 24) + 4, (view, bytes) => { view.setUint16(22, 4, true); bytes.set(new TextEncoder().encode('10k\0'), latest ? 28 : 24); });
  add('outline', 20, 40, modern ? 36 : 32, (view, bytes) => { bytes[2] = 1; bytes[3] = 0xea; write(view, modern ? 24 : 20, 41); });
  const vertices = [[0, 0], [50_000, 0], [50_000, 50_000], [0, 50_000]];
  for (let n = 0; n < vertices.length; n++) {
    add(`edge${n}`, 21, 41 + n, modern ? 44 : 40, view => {
      write(view, 8, n === 3 ? 40 : 42 + n); write(view, 12, 40);
      const at = modern ? 28 : 24, start = vertices[n], end = vertices[(n + 1) % 4];
      [start[0], start[1], end[0], end[1]].forEach((value, index) => write(view, at + index * 4, value));
    });
  }
  const data = new Uint8Array(offset + 4), view = new DataView(data.buffer);
  const magic = { 160: 0x130000, 162: 0x130400, 164: 0x130c00, 165: 0x131000, 166: 0x131500, 172: 0x140400, 174: 0x140900, 175: 0x141500 }[version];
  view.setUint32(0, magic | 3, true); data.set(new TextEncoder().encode('all'), 0xf8);
  data[0x180] = 1; view.setUint32(20, objectCount, true); view.setUint32(0x194, strings.length, true); view.setUint32(0x26c, options.divisor ?? 100, true);
  let at = 0x1200; for (const piece of pieces) { data.set(piece, at); at += piece.length; }
  return { data, offsets };
}
