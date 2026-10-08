/*
 * Original bounded Jet3/Jet4 scalar-table reader. Record offsets were checked against the MIT mdb-reader 3.2.0
 * format descriptions (Copyright (c) 2020 Andi Pätzold; assets/licenses/mdb-reader-MIT.txt).
 * This reads catalog and selected scalar columns only: no external reader, Buffer polyfill, indexes or executable data.
 */
import { BoardFormatError, MAX_IMPORT_BYTES } from './common';

export const BV_FORMAT = 'Jet BV boardview';
const MAX_COLUMNS = 256, MAX_DEFINITION = 1 << 20, MAX_TABLE_ROWS = 1_000_000;
const ENGINE = 'Standard Jet DB';
export function isJetDatabase(data: Uint8Array): boolean {
  return data.length >= 20 && data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0
    && [...ENGINE].every((char, i) => data[4 + i] === char.charCodeAt(0)) && data[19] === 0;
}
function invalid(message: string): never { throw new BoardFormatError(`BV: ${message}`, 'INVALID_FORMAT', BV_FORMAT); }
function unsupported(message: string): never { throw new BoardFormatError(`BV: ${message}`, 'UNSUPPORTED_VARIANT', BV_FORMAT); }
function limit(message: string): never { throw new BoardFormatError(`BV: ${message}`, 'LIMIT_EXCEEDED', BV_FORMAT); }

class Bytes {
  private readonly view: DataView;
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  check(at: number, size: number): void {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at > this.data.length - size) invalid('truncated record or out-of-range offset.');
  }
  u8(at: number): number { this.check(at, 1); return this.view.getUint8(at); }
  u16(at: number): number { this.check(at, 2); return this.view.getUint16(at, true); }
  u32(at: number): number { this.check(at, 4); return this.view.getUint32(at, true); }
  i16(at: number): number { this.check(at, 2); return this.view.getInt16(at, true); }
  i32(at: number): number { this.check(at, 4); return this.view.getInt32(at, true); }
  f32(at: number): number { this.check(at, 4); return this.view.getFloat32(at, true); }
  f64(at: number): number { this.check(at, 8); return this.view.getFloat64(at, true); }
  slice(at: number, size: number): Uint8Array { this.check(at, size); return this.data.subarray(at, at + size); }
}

/** Jet's fixed database-header obfuscation. File data-page encryption is deliberately unsupported. */
export function jetHeaderMask(data: Uint8Array): Uint8Array {
  const key = [0xc7, 0xda, 0x39, 0x6b], state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % 4]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  const out = new Uint8Array(data.length); let i = 0; j = 0;
  for (let n = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; out[n] = data[n] ^ state[(state[i] + state[j]) & 255]; }
  return out;
}

interface Layout {
  pageSize: number; rowCount: number; columnCount: number; variableCount: number; indexes: number; indexStart: number;
  indexSize: number; columnSize: number; columnIndex: number; variableIndex: number; flags: number; fixedIndex: number;
  size: number; map: number; nameSize: number; rowDirectory: number; countSize: number;
}
const JET3: Layout = { pageSize: 2048, rowCount: 12, columnCount: 25, variableCount: 23, indexes: 31, indexStart: 43,
  indexSize: 8, columnSize: 18, columnIndex: 1, variableIndex: 3, flags: 13, fixedIndex: 14, size: 16, map: 35, nameSize: 1, rowDirectory: 8, countSize: 1 };
const JET4: Layout = { pageSize: 4096, rowCount: 16, columnCount: 45, variableCount: 43, indexes: 51, indexStart: 63,
  indexSize: 12, columnSize: 25, columnIndex: 5, variableIndex: 7, flags: 15, fixedIndex: 21, size: 23, map: 55, nameSize: 2, rowDirectory: 12, countSize: 2 };
export type JetValue = string | number | boolean | null;
export interface JetColumn { name: string; type: number; index: number; variableIndex: number; fixedIndex: number; size: number; fixed: boolean }
export interface JetTable { name: string; count: number; columns: JetColumn[]; rows: Record<string, JetValue>[] }
interface Definition { page: number; count: number; variableCount: number; columns: JetColumn[]; dataPages: number[] }

export class JetDatabase {
  readonly version: 3 | 4;
  private readonly layout: Layout;
  private readonly pageCount: number;
  private readonly tables = new Map<string, number>();
  constructor(private readonly data: Uint8Array) {
    if (!isJetDatabase(data)) invalid('missing Jet database signature.');
    if (data.length > MAX_IMPORT_BYTES) limit('database exceeds the byte limit.');
    if (data.length <= 20) invalid('truncated database header.');
    if (data[20] !== 0 && data[20] !== 1) unsupported('only Jet3 and Jet4 boardview databases are supported.');
    this.version = data[20] === 0 ? 3 : 4; this.layout = this.version === 3 ? JET3 : JET4;
    this.pageCount = data.length / this.layout.pageSize;
    if (!Number.isInteger(this.pageCount) || this.pageCount < 3) invalid('truncated database page.');
    const header = Uint8Array.from(data.subarray(0, this.layout.pageSize));
    header.set(jetHeaderMask(header.subarray(24, this.version === 3 ? 150 : 152)), 24);
    if (header.subarray(62, 66).some(byte => byte !== 0)) unsupported('encrypted database data pages are not supported.');
    const catalog = this.readDefinition(2);
    const rows = this.readRows(catalog, ['Id', 'Name', 'Type', 'Flags'], 4096);
    for (const row of rows) {
      if (typeof row.Type !== 'number' || !Number.isInteger(row.Type) || typeof row.Flags !== 'number' || !Number.isInteger(row.Flags)) invalid('invalid catalog object fields.');
      if ((row.Type & 0x7f) !== 1 || (row.Flags & 0x80000002) !== 0) continue;
      if (typeof row.Name !== 'string' || !row.Name || typeof row.Id !== 'number' || !Number.isInteger(row.Id)) invalid('invalid catalog table reference.');
      if (this.tables.has(row.Name)) invalid('duplicate catalog table name.');
      const page = row.Id & 0xffffff;
      this.page(page, 2); this.tables.set(row.Name, page);
    }
  }
  private page(number: number, type?: number): Bytes {
    if (!Number.isInteger(number) || number <= 0 || number >= this.pageCount) invalid('page reference is outside the database.');
    const page = new Bytes(this.data.subarray(number * this.layout.pageSize, (number + 1) * this.layout.pageSize));
    if (type !== undefined && page.u8(0) !== type) invalid('page reference has the wrong record type.');
    return page;
  }
  private text(data: Uint8Array): string {
    if (data.length > 8192) limit('text field exceeds the scalar text limit.');
    if (this.version === 3) return new TextDecoder('windows-1252').decode(data);
    if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xfe) {
      if (data.length % 2) invalid('odd-length Jet4 Unicode field.');
      try { return new TextDecoder('utf-16le', { fatal: true }).decode(data); }
      catch { return invalid('invalid Jet4 Unicode field.'); }
    }
    let compressed = true, out = '';
    for (let at = 2; at < data.length;) {
      if (data[at] === 0) { compressed = !compressed; at++; }
      else if (compressed) out += String.fromCharCode(data[at++]);
      else { if (at + 1 >= data.length) invalid('truncated uncompressed Unicode field.'); out += String.fromCharCode(data[at] | data[at + 1] << 8); at += 2; }
    }
    return out;
  }
  private rowRanges(page: Bytes): Array<{ start: number; end: number; flags: number }> {
    const count = page.u16(this.layout.rowDirectory), startDirectory = this.layout.rowDirectory + 2;
    page.check(startDirectory, count * 2);
    const ranges = []; let end = this.layout.pageSize;
    for (let row = 0; row < count; row++) {
      const raw = page.u16(startDirectory + row * 2), start = raw & 0x1fff;
      if (start < startDirectory + count * 2 || start > end) invalid('invalid row directory boundary.');
      ranges.push({ start, end, flags: raw & 0xe000 }); end = start;
    }
    return ranges;
  }
  private pageRow(pointer: number): Uint8Array {
    const page = this.page(pointer >>> 8, 1), range = this.rowRanges(page)[pointer & 255];
    if (!range || range.flags) invalid('invalid usage-map row pointer.');
    return page.slice(range.start, range.end - range.start);
  }
  private mapPages(data: Uint8Array): number[] {
    const map = new Bytes(data), pages: number[] = [], seen = new Set<number>();
    const bitmap = (bytes: Uint8Array, first: number) => {
      for (let byte = 0; byte < bytes.length; byte++) if (bytes[byte]) for (let bit = 0; bit < 8; bit++) {
        if (!(bytes[byte] & 1 << bit)) continue;
        const page = first + byte * 8 + bit;
        if (page <= 0 || page >= this.pageCount || seen.has(page)) invalid('invalid or duplicate usage-map page.');
        seen.add(page); pages.push(page);
      }
    };
    if (map.u8(0) === 0) bitmap(map.slice(5, data.length - 5), map.u32(1));
    else if (map.u8(0) === 1) {
      if ((data.length - 1) % 4) invalid('truncated indirect usage map.');
      const seenMaps = new Set<number>();
      for (let at = 1, index = 0; at < data.length; at += 4, index++) {
        const number = map.u32(at); if (!number) continue;
        if (seenMaps.has(number)) invalid('duplicate indirect usage-map reference.');
        seenMaps.add(number);
        const page = this.page(number, 5);
        bitmap(page.slice(4, this.layout.pageSize - 4), index * (this.layout.pageSize - 4) * 8);
      }
    } else unsupported('unknown table usage-map layout.');
    return pages;
  }
  private readDefinition(first: number): Definition {
    const chunks: Uint8Array[] = [], seen = new Set<number>(); let next = first, size = 0;
    while (next) {
      if (seen.has(next)) invalid('cyclic table-definition chain.'); seen.add(next);
      const page = this.page(next, 2), chunk = page.slice(chunks.length ? 8 : 0, this.layout.pageSize - (chunks.length ? 8 : 0));
      size += chunk.length; if (size > MAX_DEFINITION) limit('table definition exceeds its byte limit.');
      chunks.push(chunk); next = page.u32(4);
    }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    const def = new Bytes(bytes), f = this.layout, count = def.u32(f.rowCount), n = def.u16(f.columnCount), vars = def.u16(f.variableCount), indexes = def.u32(f.indexes);
    if (!n || n > MAX_COLUMNS || vars > n) invalid('invalid table column count.');
    if (count > MAX_TABLE_ROWS) limit('table row count exceeds the import limit.');
    const columnStart = f.indexStart + indexes * f.indexSize; def.check(columnStart, n * f.columnSize);
    let names = columnStart + n * f.columnSize;
    const columns: JetColumn[] = [], indices = new Set<number>(), namesSeen = new Set<string>(), variables = new Set<number>();
    for (let i = 0; i < n; i++) {
      const p = columnStart + i * f.columnSize, length = f.nameSize === 1 ? def.u8(names) : def.u16(names); names += f.nameSize;
      const name = this.text(def.slice(names, length)); names += length;
      const index = this.version === 3 ? def.u8(p + f.columnIndex) : def.u16(p + f.columnIndex);
      const column: JetColumn = { name, type: def.u8(p), index, variableIndex: def.u16(p + f.variableIndex), fixedIndex: def.u16(p + f.fixedIndex), size: def.u16(p + f.size), fixed: !!(def.u8(p + f.flags) & 1) };
      if (!name || namesSeen.has(name) || index >= MAX_COLUMNS || indices.has(index)) invalid('duplicate or invalid column definition.');
      if (!column.fixed && (column.variableIndex >= vars || variables.has(column.variableIndex))) invalid('duplicate or invalid variable-column index.');
      if (!column.fixed) variables.add(column.variableIndex); namesSeen.add(name); indices.add(index); columns.push(column);
    }
    return { page: first, count, variableCount: vars, columns, dataPages: this.mapPages(this.pageRow(def.u32(f.map))) };
  }
  private value(data: Uint8Array, column: JetColumn): JetValue {
    const field = new Bytes(data), expected = ({ 2: 1, 3: 2, 4: 4, 6: 4, 7: 8 } as Record<number, number>)[column.type];
    if (expected !== undefined && data.length !== expected) invalid('invalid scalar column width.');
    let value: JetValue;
    switch (column.type) {
      case 2: value = field.u8(0); break;
      case 3: value = field.i16(0); break;
      case 4: value = field.i32(0); break;
      case 6: value = field.f32(0); break;
      case 7: value = field.f64(0); break;
      case 10: return this.text(data);
      default: return unsupported('a required column uses an unsupported scalar type.');
    }
    if (!Number.isFinite(value)) invalid('nonfinite numeric field.'); return value;
  }
  private readRows(def: Definition, names: readonly string[], maxRows: number): Record<string, JetValue>[] {
    if (def.count > maxRows) limit('selected table exceeds its row limit.');
    const columns = names.map(name => { const col = def.columns.find(c => c.name === name); if (!col) unsupported(`missing required column ${name}.`); return col; });
    if (columns.some(col => ![1, 2, 3, 4, 6, 7, 10].includes(col.type))) unsupported('a required column uses an unsupported scalar type.');
    const rows: Record<string, JetValue>[] = [];
    for (const number of def.dataPages) {
      const page = this.page(number, 1); if (page.u32(4) !== def.page) invalid('usage-map data page belongs to another table.');
      for (const range of this.rowRanges(page)) {
        if (range.flags & 0x8000) continue; // deleted row
        if (range.flags) unsupported('overflow or unknown row flags are not supported.');
        if (rows.length >= def.count || rows.length >= maxRows) invalid('more live rows than the declared table count.');
        const row = new Bytes(page.slice(range.start, range.end - range.start)), f = this.layout;
        const count = f.countSize === 1 ? row.u8(0) : row.u16(0), maskSize = Math.ceil(count / 8), maskAt = row.data.length - maskSize;
        if (!count || count > MAX_COLUMNS) invalid('invalid row column count.'); row.check(maskAt, maskSize);
        let variableCount = 0, payloadEnd = maskAt; const offsets: number[] = [];
        if (def.variableCount) {
          if (this.version === 4) {
            variableCount = row.u16(maskAt - 2); payloadEnd = maskAt - 2 - 2 * (variableCount + 1);
            if (variableCount > def.variableCount) invalid('invalid row variable-column count.'); row.check(payloadEnd, 2 * (variableCount + 1));
            for (let i = 0; i <= variableCount; i++) offsets.push(row.u16(maskAt - 4 - 2 * i));
          } else {
            variableCount = row.u8(maskAt - 1); if (variableCount > def.variableCount) invalid('invalid row variable-column count.');
            let jumps = Math.floor((row.data.length - 1) / 256), pointer = maskAt - jumps - 2;
            if ((pointer - variableCount) / 256 < jumps) jumps--;
            payloadEnd = pointer - variableCount; row.check(payloadEnd, variableCount + 1); let used = 0;
            for (let i = 0; i <= variableCount; i++) { while (used < jumps && i === row.u8(maskAt - used - 2)) used++; offsets.push(row.u8(pointer - i) + used * 256); }
          }
          for (let i = 0; i < offsets.length; i++) if (offsets[i] < f.countSize || offsets[i] > payloadEnd || i > 0 && offsets[i] < offsets[i - 1]) invalid('invalid variable-field boundary.');
          payloadEnd = offsets.at(-1)!;
        }
        const record: Record<string, JetValue> = Object.create(null);
        for (const col of columns) {
          if (col.index >= count) { record[col.name] = null; continue; }
          const present = !!(row.u8(maskAt + (col.index >> 3)) & 1 << (col.index & 7));
          if (col.type === 1) { record[col.name] = present; continue; }
          if (!present) { record[col.name] = null; continue; }
          let start: number, size: number;
          if (col.fixed) { start = f.countSize + col.fixedIndex; size = col.size; }
          else if (col.variableIndex < variableCount) { start = offsets[col.variableIndex]; size = offsets[col.variableIndex + 1] - start; }
          else { record[col.name] = null; continue; }
          const end = col.fixed && offsets.length ? offsets[0] : payloadEnd;
          if (start < f.countSize || start + size > end) invalid('field overlaps the row metadata or variable payload.');
          record[col.name] = this.value(row.slice(start, size), col);
        }
        rows.push(record);
      }
    }
    if (rows.length !== def.count) invalid('live rows do not match the declared table count.');
    return rows;
  }
  hasTable(name: string): boolean { return this.tables.has(name); }
  declaredRows(name: string): number {
    const page = this.tables.get(name); if (page === undefined) unsupported(`missing required table ${name}.`);
    return this.readDefinition(page).count;
  }
  table(name: string, names: readonly string[], maxRows = MAX_TABLE_ROWS): JetTable {
    const page = this.tables.get(name); if (page === undefined) unsupported(`missing required table ${name}.`);
    const def = this.readDefinition(page);
    return { name, count: def.count, columns: def.columns, rows: this.readRows(def, names, maxRows) };
  }
  columnNames(name: string): string[] {
    const page = this.tables.get(name); if (page === undefined) unsupported(`missing required table ${name}.`);
    return this.readDefinition(page).columns.map(column => column.name);
  }
}
