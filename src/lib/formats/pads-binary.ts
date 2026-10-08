/* Original TRACE module, MIT. Framing facts: KiCad's public PADS format description.
 * This does not decode a board: custom-decal terminal geometry still needs independent validation.
 */
import { BoardFormatError, MAX_IMPORT_BYTES, startsWithBytes, type BoardParser } from './common';
import type { StructureHook } from './structure-hook';

const ID = 'pads-binary';
const FOOTER = new TextEncoder().encode('{2FE18320-6448-11d1-A412-000000000000}');
const MAX_CONTROLLERS = 256;
interface Controller { count: number; extent: number }
interface Header { version: number; subversion: number; start: number; controllers: Controller[] }

/** The native magic and exact observed database versions, independent of the file name. */
export function padsBinaryVersion(data: Uint8Array): number | null {
  if (data.length < 4 || data[0] !== 0 || data[1] !== 0xff || data[3] !== 0x20 || (data[2] !== 0x26 && data[2] !== 0x27)) return null;
  return data[2] | (data[3] << 8);
}
function fail(message: string, code: 'INVALID_FORMAT' | 'UNSUPPORTED_VARIANT' | 'LIMIT_EXCEEDED' = 'INVALID_FORMAT'): never {
  throw new BoardFormatError(`PADS native SDB: ${message}`, code, ID);
}
function headerOf(data: Uint8Array): Header {
  if (data.length > MAX_IMPORT_BYTES) fail('database exceeds the 64 MiB import limit.', 'LIMIT_EXCEEDED');
  const version = padsBinaryVersion(data);
  if (version === null) fail('missing native database signature.');
  if (data.length < 38) fail('truncated controller-directory header.');
  const view = new DataView(data.buffer, data.byteOffset, data.length), subversion = view.getUint16(4, true);
  if (subversion > 3) fail('unverified database subversion; request an original PADS Layout ASCII export. See docs/PADS-BINARY.md.', 'UNSUPPORTED_VARIANT');
  const count = view.getUint32(26, true);
  if (count > MAX_CONTROLLERS) fail('controller-directory count exceeds the bounded diagnostic limit.', 'LIMIT_EXCEEDED');
  if (count < 25) fail('controller directory is missing the native placement/net/connection slots.');
  const start = 6 + count * 16;
  if (start > data.length) fail('truncated controller directory.');
  if (view.getUint32(30, true) !== count * 16) fail('controller-directory byte extent disagrees with its slot count.');
  const controllers: Controller[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    if (view.getUint32(at, true) !== 0) fail('nonzero unused controller-slot word.');
    controllers.push({ count: view.getUint32(at + 4, true), extent: view.getUint32(at + 8, true) });
  }
  return { version, subversion, start, controllers };
}

/** Only the explicit flat-controller prefix and EOF-anchored document footer are inspected.
 * Later paged controllers use descriptor counts, so summing every directory extent as bytes is incorrect.
 */
function frameOf(data: Uint8Array, header: Header): void {
  const footerAt = data.length - 42;
  if (footerAt < header.start || !startsWithBytes(data.subarray(footerAt), FOOTER)) fail('missing native document footer at end of file; the database may be truncated.');
  const view = new DataView(data.buffer, data.byteOffset, data.length), itemsAt = view.getUint32(data.length - 4, true);
  if (itemsAt < header.start || itemsAt > footerAt - 4) fail('document container-array back-pointer is outside the database.');
  let end = header.start;
  for (let index = 2; index <= 24; index++) {
    const size = header.controllers[index].extent;
    if (size > itemsAt - end) fail('flat-controller extent crosses the document container array.');
    end += size;
  }
  // An empty container-item array has no trailing item records. Nonempty arrays remain opaque.
  if (view.getUint32(itemsAt, true) === 0 && itemsAt + 4 !== footerAt) fail('empty document container array has trailing bytes.');
}

export const parsePadsBinary: BoardParser = input => {
  if (padsBinaryVersion(input.data) === null) return null;
  const header = headerOf(input.data);
  frameOf(input.data, header);
  return fail(`database version 0x${header.version.toString(16)} is recognized, but native custom-decal pin geometry and terminal mapping are not yet validated in TRACE. Request a PADS Layout ASCII (.asc) export, import that export into KiCad, check geometry and net assignments, then save a separate .kicad_pcb file for TRACE. Direct native import failed in both tested stable and development KiCad builds. See docs/PADS-BINARY.md.`, 'UNSUPPORTED_VARIANT');
};

export const padsBinaryHook: StructureHook = {
  id: ID, kind: 'binary', keywords: [], steps: ['header', 'container'],
  collect({ data }, sink) {
    const version = padsBinaryVersion(data);
    if (version === null) return;
    sink.variant(version === 0x2026 ? 'pads-sdb-2026' : 'pads-sdb-2027');
    sink.code('version', version);
    let header: Header;
    try { header = headerOf(data); } catch { return; }
    sink.reached('header');
    sink.count('sections', header.controllers.length);
    // These are declared records, including retained/alias net slots; terminal storage is not a pin count.
    sink.count('declaredParts', header.controllers[22].count);
    sink.count('declaredNets', header.controllers[23].count);
    sink.block(0, header.start, 8);
    try { frameOf(data, header); } catch { return; }
    for (let index = 2; index <= 24; index++) sink.block(index, header.controllers[index].extent, 8);
    sink.block(255, 42, 8);
    sink.reached('container');
  },
};
