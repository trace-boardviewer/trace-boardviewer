/*
 * OLE compound file (MS-CFB) reader shared by the Altium board (PcbDoc) and schematic (SchDoc) adapters. Original TRACE code (MIT);
 * the container follows [MS-CFB] and no implementation source code was read or copied. It is bounded (directory entries, storage
 * depth, extraction budget) and, unlike the `cfb` package, detects FAT-chain cycles. Failures are reported through `raise` so each
 * adapter keeps its own error type: `raise` must throw.
 */
export type CompoundFailCode = 'INVALID_FORMAT' | 'UNSUPPORTED_VARIANT' | 'LIMIT_EXCEEDED';
export type CompoundFail = (message: string, code: CompoundFailCode) => never;

export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_DIRECTORY_ENTRIES = 100_000, MAX_STORAGE_DEPTH = 8;

export interface Compound { paths: string[]; stream(path: string): Uint8Array | undefined }
interface DirEntry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
const MAXREGSECT = 0xfffffffa, ENDOFCHAIN = 0xfffffffe, NOSTREAM = 0xffffffff;

export function readCompound(data: Uint8Array, raise: CompoundFail): Compound {
  const bad = (message: string): never => raise(`Altium compound file ${message}.`, 'INVALID_FORMAT');
  if (data.length < 512) bad('is shorter than its 512-byte header');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  const version = u16(26), shift = u16(30);
  if (u16(28) !== 0xfffe) bad('has an invalid byte-order mark');
  if (version === 4 && shift === 12) raise('Altium compound file uses 4096-byte sectors (version 4), which is untested and not supported.', 'UNSUPPORTED_VARIANT');
  if (version !== 3 || shift !== 9 || u16(32) !== 6 || u32(56) !== 4096) bad(`uses an unsupported layout (version ${version}, sector shift ${shift})`);
  const sectorSize = 1 << shift, sectorCount = Math.floor(data.length / sectorSize) - 1, perSector = sectorSize / 4;
  const sector = (index: number): Uint8Array => {
    if (index >= sectorCount) bad(`references sector ${index > MAXREGSECT ? 'with a reserved id' : index} outside the file (${sectorCount} sectors)`);
    return data.subarray((index + 1) * sectorSize, (index + 2) * sectorSize);
  };
  const dataView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fatCount = u32(44), difatCount = u32(72);
  if (fatCount < 1 || fatCount > sectorCount || difatCount > sectorCount) bad(`declares ${fatCount} FAT and ${difatCount} DIFAT sectors for a file of ${sectorCount} sectors`);
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(u32(76 + i * 4));
  for (let next = u32(68), used = 0; fatSectors.length < fatCount; used++) {
    if (used >= difatCount) bad('lists fewer FAT sectors than it declares');
    const content = dataView(sector(next));
    for (let i = 0; i < perSector - 1 && fatSectors.length < fatCount; i++) fatSectors.push(content.getUint32(i * 4, true));
    next = content.getUint32((perSector - 1) * 4, true);
  }
  const fatViews = fatSectors.map(index => dataView(sector(index)));
  const fat = (index: number): number => {
    const owner = fatViews[Math.floor(index / perSector)];
    if (!owner) bad(`references allocation entry ${index} outside the FAT`);
    return owner.getUint32((index % perSector) * 4, true);
  };
  /** The first `count` sectors of a chain; ending early or revisiting a sector is corruption. */
  const chain = (start: number, count: number, label: string): number[] => {
    if (count > sectorCount) bad(`${label} needs ${count} sectors but the file has ${sectorCount}`);
    const out: number[] = [], seen = new Set<number>();
    for (let at = start; out.length < count;) {
      if (at >= sectorCount) bad(`${label} ends after ${out.length} of ${count} sectors`);
      if (seen.has(at)) bad(`${label} loops back to sector ${at}`);
      seen.add(at); out.push(at);
      if (out.length < count) at = fat(at);
    }
    return out;
  };
  let spent = 0;
  const spend = (size: number, label: string) => {
    spent += size;
    if (spent > data.length * 2) raise(`Altium compound file ${label} exceeds the extraction budget.`, 'LIMIT_EXCEEDED');
  };
  const readChain = (start: number, size: number, label: string): Uint8Array => {
    spend(size, label);
    if (size > sectorCount * sectorSize) bad(`${label} claims ${size} bytes in a file of ${data.length}`);
    const out = new Uint8Array(size);
    chain(start, Math.ceil(size / sectorSize), label).forEach((index, order) => out.set(sector(index).subarray(0, Math.min(sectorSize, size - order * sectorSize)), order * sectorSize));
    return out;
  };

  const directory: number[] = [];
  for (let at = u32(48), seen = new Set<number>(); at !== ENDOFCHAIN; at = fat(at)) {
    if (at >= sectorCount) bad('has a directory chain that leaves the file');
    if (seen.has(at)) bad('has a looping directory chain');
    seen.add(at); directory.push(at);
    if (directory.length * (sectorSize / 128) > MAX_DIRECTORY_ENTRIES) raise(`Altium compound file has more than ${MAX_DIRECTORY_ENTRIES} directory entries.`, 'LIMIT_EXCEEDED');
  }
  if (!directory.length) bad('has no directory');
  const entries: DirEntry[] = [];
  for (const index of directory) {
    const content = dataView(sector(index));
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const type = content.getUint8(offset + 66), nameBytes = content.getUint16(offset + 64, true);
      if (type !== 0 && ![1, 2, 5].includes(type)) bad(`has directory entry ${entries.length} with unknown type ${type}`);
      if (type !== 0 && (nameBytes < 2 || nameBytes > 64 || nameBytes % 2)) bad(`has directory entry ${entries.length} with an invalid name length`);
      let name = '';
      if (type !== 0) for (let unit = 0; unit < nameBytes / 2 - 1; unit++) name += String.fromCharCode(content.getUint16(offset + unit * 2, true));
      entries.push({ name, type, left: content.getUint32(offset + 68, true), right: content.getUint32(offset + 72, true), child: content.getUint32(offset + 76, true),
        start: content.getUint32(offset + 116, true), size: content.getUint32(offset + 120, true) }); // Version 3 uses only the low 32 bits of the size.
    }
  }
  if (entries[0].type !== 5) bad('has no root entry');
  const byPath = new Map<string, DirEntry>(), paths: string[] = [], visited = new Uint8Array(entries.length);
  visited[0] = 1;
  const pending: Array<{ node: number; prefix: string; depth: number }> = [{ node: entries[0].child, prefix: '', depth: 1 }];
  while (pending.length) {
    const { node, prefix, depth } = pending.pop()!;
    if (node === NOSTREAM) continue;
    if (node >= entries.length) bad('has a directory link outside the directory');
    if (visited[node]) bad('has a directory entry that is linked twice');
    visited[node] = 1;
    const entry = entries[node];
    if (entry.type !== 1 && entry.type !== 2) bad(`has a directory link to an entry of type ${entry.type}`);
    if (depth > MAX_STORAGE_DEPTH) raise(`Altium compound file nests storages deeper than ${MAX_STORAGE_DEPTH} levels.`, 'LIMIT_EXCEEDED');
    const path = `${prefix}/${entry.name}`;
    if (byPath.has(path.toUpperCase())) bad(`has two entries named ${path.slice(0, 80)}`);
    byPath.set(path.toUpperCase(), entry); paths.push(path);
    pending.push({ node: entry.left, prefix, depth }, { node: entry.right, prefix, depth });
    if (entry.type === 1) pending.push({ node: entry.child, prefix: path, depth: depth + 1 });
  }

  let mini: { container: Uint8Array; table: DataView } | undefined;
  const miniStore = () => mini ??= {
    container: readChain(entries[0].start, entries[0].size, 'mini-stream container'),
    table: dataView(u32(64) ? readChain(u32(60), u32(64) * sectorSize, 'mini FAT') : new Uint8Array(0)),
  };
  const readMini = (entry: DirEntry, label: string): Uint8Array => {
    const { container, table } = miniStore(), count = Math.ceil(entry.size / 64);
    spend(entry.size, label);
    if (count * 64 > container.length + 63) bad(`${label} is larger than the mini-stream`);
    const out = new Uint8Array(entry.size), seen = new Set<number>();
    for (let at = entry.start, done = 0; done < count; done++) {
      if (at >= container.length / 64 || seen.has(at)) bad(`${label} has an invalid mini-sector chain`);
      seen.add(at);
      out.set(container.subarray(at * 64, at * 64 + Math.min(64, entry.size - done * 64)), done * 64);
      if (done + 1 < count) { if ((at + 1) * 4 > table.byteLength) bad(`${label} leaves the mini FAT`); at = table.getUint32(at * 4, true); }
    }
    return out;
  };
  return {
    paths,
    stream(path) {
      const entry = byPath.get(path.toUpperCase());
      if (!entry || entry.type !== 2) return undefined;
      if (!entry.size) return new Uint8Array(0);
      return entry.size < 4096 ? readMini(entry, `stream ${path}`) : readChain(entry.start, entry.size, `stream ${path}`);
    },
  };
}
