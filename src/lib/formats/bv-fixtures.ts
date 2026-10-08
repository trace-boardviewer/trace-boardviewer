/** Original synthetic Jet databases. No bytes or strings from a vendor database are used. */
import { jetHeaderMask } from './bv-jet';

type Value = string | number | null;
type RecordRow = Record<string, Value>;
interface Column { name: string; type: number; fixed?: number; variable?: number }
interface Table { name: string; page: number; columns: Column[]; rows: RecordRow[] }
export interface BvFixtureOptions {
  jet3?: boolean; group?: boolean; layout?: RecordRow[]; pins?: RecordRow[]; nails?: RecordRow[];
  indirectMap?: boolean; compressedText?: boolean;
}
export const BV_SYNTHETIC_PINS: RecordRow[] = [
  { Part: 'U1', TB: '(T)', Pin: 17, Name: 'A1', X: 0.25, Y: -0.125, Layer: 1, Net: 'VCC' },
  { Part: 'U1', TB: '(T)', Pin: 18, Name: 'B2', X: 0.5, Y: 0.125, Layer: 1, Net: 'GND' },
  { Part: 'R1', TB: '(B)', Pin: 1, Name: '1', X: 0.75, Y: 0.25, Layer: 2, Net: 'GND' },
  { Part: 'R1', TB: '(B)', Pin: 2, Name: '2', X: 0.875, Y: 0.25, Layer: 2, Net: 'UNCONNECTED1' },
];
export const BV_SYNTHETIC_NAILS: RecordRow[] = [
  { Nail: '$25', X: 1.25, Y: 0.5, Type: 0, Grid: 'G1', TB: '(B)', NET: '99', NetName: 'VCC', VirtualPinVia: 'VIRTUAL PIN' },
];
const width = (type: number) => ({ 3: 2, 4: 4, 6: 4, 7: 8 } as Record<number, number>)[type] ?? 0;

export function syntheticBv(options: BvFixtureOptions = {}): Uint8Array {
  const jet3 = !!options.jet3, size = jet3 ? 2048 : 4096, countSize = jet3 ? 1 : 2, directory = jet3 ? 8 : 12;
  const data = new Uint8Array(size * (options.indirectMap ? 14 : 10)), view = new DataView(data.buffer);
  const setCount = (at: number, value: number) => countSize === 1 ? view.setUint8(at, value) : view.setUint16(at, value, true);
  const encode = (text: string, columnName = false): Uint8Array => {
    if (jet3) return Uint8Array.from(text, char => char.charCodeAt(0));
    if (options.compressedText && !columnName && [...text].every(c => c.charCodeAt(0) > 0 && c.charCodeAt(0) < 256)) return Uint8Array.from([255, 254, ...[...text].map(c => c.charCodeAt(0))]);
    const out = new Uint8Array(text.length * 2), target = new DataView(out.buffer); for (let i = 0; i < text.length; i++) target.setUint16(i * 2, text.charCodeAt(i), true); return out;
  };
  const layoutCols: Column[] = [{ name: 'X', type: 7, fixed: 0 }, { name: 'Y', type: 7, fixed: 8 }, { name: 'R', type: 7, fixed: 16 }];
  if (options.group !== false) layoutCols.push({ name: 'Group', type: 3, fixed: 24 });
  const pinCols: Column[] = [
    { name: 'Part', type: 10, variable: 0 }, { name: 'TB', type: 10, variable: 1 }, { name: 'Pin', type: 4, fixed: 0 },
    { name: 'Name', type: 10, variable: 2 }, { name: 'X', type: 6, fixed: 4 }, { name: 'Y', type: 6, fixed: 8 },
    { name: 'Layer', type: 3, fixed: 12 }, { name: 'Net', type: 10, variable: 3 },
  ];
  const nailCols: Column[] = [
    { name: 'Nail', type: 10, variable: 0 }, { name: 'X', type: 7, fixed: 0 }, { name: 'Y', type: 7, fixed: 8 },
    { name: 'Type', type: 4, fixed: 16 }, { name: 'Grid', type: 10, variable: 1 }, { name: 'TB', type: 10, variable: 2 },
    { name: 'NET', type: 10, variable: 3 }, { name: 'NetName', type: 10, variable: 4 }, { name: 'VirtualPinVia', type: 10, variable: 5 },
  ];
  const tables: Table[] = [
    { name: 'MSysObjects', page: 2, columns: [{ name: 'Id', type: 4, fixed: 0 }, { name: 'Type', type: 3, fixed: 4 }, { name: 'Flags', type: 4, fixed: 6 }, { name: 'Name', type: 10, variable: 0 }], rows: [{ Id: 3, Type: 1, Flags: 0, Name: 'Layout' }, { Id: 4, Type: 1, Flags: 0, Name: 'Pin' }, { Id: 5, Type: 1, Flags: 0, Name: 'Nail' }] },
    { name: 'Layout', page: 3, columns: layoutCols, rows: options.layout ?? [{ X: 0, Y: 0, R: 0, Group: 2 }, { X: 2, Y: 0, R: 0, Group: 2 }, { X: 2, Y: 1, R: 0, Group: 2 }, { X: 0, Y: 1, R: 0, Group: 2 }] },
    { name: 'Pin', page: 4, columns: pinCols, rows: options.pins ?? BV_SYNTHETIC_PINS },
    { name: 'Nail', page: 5, columns: nailCols, rows: options.nails ?? BV_SYNTHETIC_NAILS },
  ];
  const record = (table: Table, row: RecordRow): Uint8Array => {
    const fixedSize = Math.max(0, ...table.columns.filter(c => c.fixed !== undefined).map(c => c.fixed! + width(c.type)));
    const vars = table.columns.filter(c => c.variable !== undefined).sort((a, b) => a.variable! - b.variable!);
    const fields = vars.map(c => row[c.name] === null ? new Uint8Array() : encode(String(row[c.name] ?? '')));
    const offsets = [countSize + fixedSize]; for (const field of fields) offsets.push(offsets.at(-1)! + field.length);
    const payload = offsets.at(-1)!, maskSize = Math.ceil(table.columns.length / 8);
    const baseLength = payload + (vars.length ? countSize * (vars.length + 2) : 0) + maskSize;
    let jumps = jet3 && vars.length ? Math.floor((baseLength - 1) / 256) : 0;
    while (jet3 && vars.length && Math.floor((baseLength + jumps - 1) / 256) !== jumps) jumps = Math.floor((baseLength + jumps - 1) / 256);
    const out = new Uint8Array(baseLength + jumps), target = new DataView(out.buffer);
    if (jet3) target.setUint8(0, table.columns.length); else target.setUint16(0, table.columns.length, true);
    table.columns.forEach((c, i) => {
      if (row[c.name] !== null) out[out.length - maskSize + (i >> 3)] |= 1 << (i & 7);
      if (c.fixed === undefined || row[c.name] === null) return;
      const at = countSize + c.fixed, value = Number(row[c.name]);
      if (c.type === 3) target.setInt16(at, value, true); if (c.type === 4) target.setInt32(at, value, true);
      if (c.type === 6) target.setFloat32(at, value, true); if (c.type === 7) target.setFloat64(at, value, true);
    });
    fields.forEach((field, i) => out.set(field, offsets[i]));
    if (vars.length) {
      let at = payload; for (const offset of [...offsets].reverse()) { if (jet3) target.setUint8(at, offset & 255); else target.setUint16(at, offset, true); at += countSize; }
      if (jumps) {
        const boundaries = Array.from({ length: jumps }, (_, jump) => { const index = offsets.findIndex(offset => offset >= (jump + 1) * 256); return index < 0 ? 255 : index; });
        for (const index of boundaries.reverse()) target.setUint8(at++, index);
      }
      if (jet3) target.setUint8(at, vars.length); else target.setUint16(at, vars.length, true);
    }
    return out;
  };
  const rowsOnPage = (page: number, owner: number, rows: Uint8Array[]) => {
    const base = page * size; data[base] = 1; data[base + 1] = 1; view.setUint32(base + 4, owner, true); view.setUint16(base + directory, rows.length, true);
    let end = size; rows.forEach((row, index) => { end -= row.length; if (end < directory + 2 + rows.length * 2) throw new Error('synthetic page overflow'); data.set(row, base + end); view.setUint16(base + directory + 2 + index * 2, end, true); });
  };
  const maps: Uint8Array[] = [];
  tables.forEach((table, index) => {
    const base = table.page * size, vars = table.columns.filter(c => c.variable !== undefined).length;
    data[base] = 2; data[base + 1] = 1;
    view.setUint32(base + (jet3 ? 12 : 16), table.rows.length, true); view.setUint16(base + (jet3 ? 25 : 45), table.columns.length, true); view.setUint16(base + (jet3 ? 23 : 43), vars, true);
    view.setUint32(base + (jet3 ? 35 : 55), 256 + index, true);
    const columnStart = base + (jet3 ? 43 : 63), entrySize = jet3 ? 18 : 25; let nameAt = columnStart + entrySize * table.columns.length;
    table.columns.forEach((column, n) => {
      const at = columnStart + n * entrySize; data[at] = column.type; if (jet3) data[at + 1] = n; else view.setUint16(at + 5, n, true);
      view.setUint16(at + (jet3 ? 3 : 7), column.variable ?? 0, true); data[at + (jet3 ? 13 : 15)] = column.fixed === undefined ? 2 : 3;
      view.setUint16(at + (jet3 ? 14 : 21), column.fixed ?? 0, true); view.setUint16(at + (jet3 ? 16 : 23), column.type === 10 ? jet3 ? 255 : 510 : width(column.type), true);
      const name = encode(column.name, true); setCount(nameAt, name.length); nameAt += countSize; data.set(name, nameAt); nameAt += name.length;
    });
    rowsOnPage(6 + index, table.page, table.rows.map(row => record(table, row)));
    if (options.indirectMap) { const map = new Uint8Array(5); map[0] = 1; new DataView(map.buffer).setUint32(1, 10 + index, true); maps.push(map); data[(10 + index) * size] = 5; if (table.rows.length) data[(10 + index) * size + 4 + ((6 + index) >> 3)] |= 1 << ((6 + index) & 7); }
    else { const map = new Uint8Array(7); if (table.rows.length) map[5 + ((6 + index) >> 3)] |= 1 << ((6 + index) & 7); maps.push(map); }
  });
  rowsOnPage(1, 0, maps);
  data[1] = 1; data.set(new TextEncoder().encode('Standard Jet DB\0'), 4); data[20] = jet3 ? 0 : 1;
  data.set(jetHeaderMask(data.subarray(24, jet3 ? 150 : 152)), 24);
  return data;
}
