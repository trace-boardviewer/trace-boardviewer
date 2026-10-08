import { describe, expect, it } from 'vitest';
import { sniffAny } from './sniff-any';
import { defineBoardAdapter, SNIFF_BYTES, type BoardAdapter } from '../formats/adapter';
const diskFixtures = import.meta.glob('../../../tests/fixtures/{ipc356,pinlist}/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const bytes = (text: string) => new TextEncoder().encode(text);
const binary = (...values: number[]) => new Uint8Array(values);
const cst = binary(1, 0, 0, 0, 0, 0, 4, 0, 67, 68, 101, 118);
const cfb = binary(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const allegro = new Uint8Array(256); new DataView(allegro.buffer).setUint32(0, 0x00130000, true); allegro.set(bytes('all'), 248);
/** A head of the size a scan reads: the first SNIFF_BYTES of a file of this size (shorter files are read whole). */
const windowOf = (size: number, ...lead: number[]) => { const head = new Uint8Array(Math.min(size, SNIFF_BYTES)); head.set(lead); return head; };
/** A board reader that only sniffs; the library calls sniffs and never the parse. */
const reader = (id: string, extensions: string[], sniff: BoardAdapter['sniff'], maxInputBytes = 64 * 1024 * 1024): BoardAdapter => defineBoardAdapter({
  capability: { id, name: id, extensions, variants: ['test'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated', units: 'mm', sides: 'top', notes: ['test double'] },
  listOrder: 1, family: 'Boardview', detection: 'signature', limits: { maxInputBytes }, sniff, parse: () => null,
});
/** An XZZPCB header XOR-ed with the byte stored at offset 0x10, in a file long enough to hold it. */
function obfuscatedXzz(key = 0x5a) { const data = new Uint8Array(0x20); [...'XZZPCB'].forEach((letter, at) => { data[at] = letter.charCodeAt(0) ^ key; }); data[0x10] = key; return data; }
describe('bounded library format identification', () => {
  it.each([
    ['board.cad', '$HEADER\nGENCAD 1.4\n$ENDHEADER', 'gencad', 'board'],
    ['encoded.brd', binary(0x23, 0xe2, 0x63, 0x28), 'brd', 'board'],
    ['board.brd', 'BRDOUT: 4 100 100', 'brd2', 'board'],
    ['board.bvr', 'BVRAW_FORMAT_3\nPART_NAME U1', 'bvr', 'board'],
    ['old.bvr', 'BVRAW_FORMAT_1\n<<Layout>>', 'bvr1', 'board'],
    ['board.bdv', '<<format.asc>>\n<<pins.asc>>', 'bdv', 'board'],
    ['encoded.bdv', 'dd:1.3?,r?-=bb', 'bdv', 'board'],
    ['pins.asc', 'U1 1 0 0', 'asc', 'board'],
    ['board.fz', 'A!REFDES\nS!U1', 'fz', 'board'],
    ['encrypted.cae', binary(1, 0, 7, 19, 250), 'fz', 'board'],
    ['board.pcb', 'XZZPCB\0payload', 'xzz', 'board'],
    ['board.cst', cst, 'cst', 'board'],
    ['board.kicad_pcb', '(kicad_pcb (version 20240108))', 'kicad', 'board'],
    ['board.brd', '<?xml version="1.0"?><eagle><drawing><board></board></drawing></eagle>', 'eagle', 'board'],
    ['board.pcbdoc', '|RECORD=Board|KIND=Protel_Advanced_PCB|', 'altium', 'board'],
    ['board.pcbdoc', cfb, 'altium', 'board'],
    ['board.cad', '###Panel Added\nC_PIN 1 U1-1 0 0', 'samsung-cad', 'board'],
    ['board.json', '{"head":{"docType":"3"},"canvas":"CA~","shape":["PAD~"]}', 'easyeda-std', 'board'],
    ['board.epcb', '["DOCTYPE","PCB","1.8"]\n', 'easyeda-pro', 'board'],
    ['board.xml', '<IPC-2581 revision="C"/>', 'ipc2581', 'board'],
    ['board.gbr', '%FSLAX24Y24*%\n%MOMM*%', 'gerber', 'board'],
    ['board.neu', '# file : synthetic\n# date : 2000-01-01', 'mentor-neutral', 'board'],
    ['native.brd', allegro, 'allegro-brd', 'board'],
    ['board.pdf', '%PDF-1.7\n%%EOF', 'pdf', 'pdf'],
    ['board.kicad_sch', '(kicad_sch (version 20240108))', 'kicad_sch', 'schematic'],
    ['board.sch', 'EESchema Schematic File Version 4\n', 'eeschema', 'schematic'],
    ['board.sch', '<eagle><drawing><schematic></schematic></drawing></eagle>', 'eagle', 'schematic'],
    ['board.schdoc', cfb, 'altium-sch', 'schematic'],
    ['board.png', binary(137, 80, 78, 71, 13, 10, 26, 10), 'png', 'image'],
    ['board.jpeg', binary(255, 216, 255, 224, 0, 16), 'jpeg', 'image'],
    ['board.zip', binary(80, 75, 3, 4, 0), 'zip', 'archive'],
    ['board.rar', binary(82, 97, 114, 33, 26, 7, 0), 'rar', 'archive'],
    ['board.7z', binary(55, 122, 188, 175, 39, 28), '7z', 'archive'],
    ['board.tgz', binary(31, 139, 8, 0, 0), 'gzip', 'archive'],
    ['bom.xls', cfb, 'xls', 'spreadsheet'],
    ['bom.xlsx', 'PK\u0003\u0004[Content_Types].xml xl/workbook.xml', 'xlsx', 'spreadsheet'],
    ['bom.csv', 'item,amount\nscrew,3\n', 'csv', 'spreadsheet'],
  ])('identifies synthetic %s', (name, source, format, kind) => {
    const head = typeof source === 'string' ? bytes(source) : source;
    expect(sniffAny({ head, name, size: head.length })).toMatchObject({ format, kind });
  });
  // Boards and ZIP archives are identified by the format registry, the same sniffs the dispatcher ranks. Where it differs from the earlier
  // library-only rules, the registry matches the readers (their extensions, section lines and tiers), and the names say why.
  it.each([
    ['an XZZ header under the .pcb name its reader owns, XOR-obfuscated with the key byte at offset 0x10 (the "v6v6555v6v6" text is a trailer, not a head signature)', 'board.pcb', obfuscatedXzz(), 'xzz', 'board'],
    ['Landrex section lines that stand alone on their line, as the reader reads them, whatever the file name says', 'wrong.pdf', 'str_length:\n3\nvar_data:\n0\n', 'brd', 'board'],
    ['a .epro project ZIP is an EasyEDA Pro project: the board reader (LIKELY) outranks the generic ZIP container (60)', 'project.epro', binary(80, 75, 3, 4, 0), 'easyeda-pro', 'board-archive'],
    ['a ZIP named .zip is the registry container, identified once (no second, library-made ZIP candidate)', 'board.zip', binary(80, 75, 3, 4, 0), 'zip', 'archive'],
  ])('registry decides: %s', (_reason, name, source, format, kind) => {
    const head = typeof source === 'string' ? bytes(source) : source;
    const verdict = sniffAny({ head, name, size: head.length });
    expect(verdict).toMatchObject({ format, kind });
    if (format === 'zip') expect(verdict.candidates.filter(c => c.format === 'zip')).toHaveLength(1);
  });
  it('does not mistake a spreadsheet or a schematic stored as an OLE compound file for an Altium board (the registry keeps the container only POSSIBLE under a foreign name)', () => {
    const xls = sniffAny({ head: cfb, name: 'bom.xls', size: cfb.length });
    expect(xls).toMatchObject({ format: 'xls', kind: 'spreadsheet' });
    expect(xls.candidates.find(c => c.format === 'altium')?.confidence).toBeLessThan(50);
    expect(sniffAny({ head: cfb, name: 'board.schdoc', size: cfb.length })).toMatchObject({ format: 'altium-sch', kind: 'schematic' });
  });
  it.each(Object.entries(diskFixtures))('sniffs repository fixture %s without full parsing', (path, source) => {
    const head = bytes(source); const name = path.split('/').pop()!;
    const verdict = sniffAny({ head, name, size: head.length });
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.candidates.some(c => ['ipc356', 'pinlist', 'csv', 'tsv'].includes(c.format))).toBe(true);
  });
  it('supports the newly merged readers without invoking parsers, at the registry cap below CERTAIN (structure-detected formats stay LIKELY, so two readers are never certain about one head)', async () => {
    const { sniffHyperlynx } = await import('../formats/hyperlynx');
    const { sniffFabmaster } = await import('../formats/fabmaster');
    for (const [name, source, format, sniff] of [
      ['board.hyp', '{VERSION=2.14}\n{UNITS=METRIC LENGTH}\n{BOARD\n}', 'hyperlynx', sniffHyperlynx],
      ['board.fab', 'A!REFDES!COMP_CLASS!COMP_PART_NUMBER!COMP_PACKAGE!COMP_SIDE!COMP_X!COMP_Y!COMP_ROTATION!\nJ!UNITS!MM!\n', 'fabmaster', sniffFabmaster],
    ] as const) {
      const head = bytes(source); const verdict = sniffAny({ head, name, size: head.length });
      expect(verdict.candidates.find(c => c.format === format)?.confidence ?? 0).toBe(Math.min(89, Math.round(sniff(head).confidence * 100)));
    }
  });
  it('reports two certain board candidates without choosing one', () => {
    const certain = (id: string) => reader(id, ['.cad'], () => ({ confidence: 95, reason: 'signature' }), 8);
    const result = sniffAny({ head: bytes('head'), name: 'a.cad', size: 99 }, [certain('a'), certain('b')]);
    expect(result.certainty).toBe('ambiguous'); expect(result.format).toBeUndefined(); expect(result.alternatives).toEqual(['a', 'b']);
    expect(result.candidates.every(c => c.tooLarge)).toBe(true);
  });
  it('passes only a bounded head and ranks extension ties independently of registration order', () => {
    const lengths: number[] = [];
    const probe = (id: string, extensions: string[]) => reader(id, extensions, i => { lengths.push(i.head.length); return { confidence: 75, reason: 'markers' }; }, 64);
    const a = probe('a', ['.other']), b = probe('b', ['.cad']);
    const input = { head: new Uint8Array(SNIFF_BYTES * 4), name: 'test.cad', size: SNIFF_BYTES * 4 };
    expect(sniffAny(input, [a, b]).format).toBe('b'); expect(sniffAny(input, [b, a]).format).toBe('b'); expect(lengths).toEqual([SNIFF_BYTES, SNIFF_BYTES, SNIFF_BYTES, SNIFF_BYTES]);
  });
  it('does not read a signature after the sniff window: the reader stays a POSSIBLE candidate for the parse to decide, never likely or certain', () => {
    const head = new Uint8Array(SNIFF_BYTES + 20).fill(32); head.set(bytes('BVRAW_FORMAT_3'), SNIFF_BYTES);
    const verdict = sniffAny({ head, name: 'board.bvr', size: head.length });
    const bvr = verdict.candidates.find(c => c.format === 'bvr');
    expect(bvr?.confidence).toBeGreaterThan(0); expect(bvr?.confidence).toBeLessThan(50);
    expect(verdict.certainty).toBe('possible'); expect(verdict.alternatives).toEqual([]);
  });
  it('tells a head that is the whole file from one that is only its start: nothing can lie beyond a complete head', () => {
    const blanks = bytes(' '.repeat(2048));
    expect(sniffAny({ head: blanks, name: 'board.bvr', size: blanks.length })).toMatchObject({ format: 'text', candidates: [{ format: 'text' }] });
    expect(sniffAny({ head: blanks, name: 'board.bvr', size: 4 * SNIFF_BYTES }).candidates.some(c => c.format === 'bvr')).toBe(true);
  });
  it('handles BOM-marked UTF-16 and does not parse firmware', () => {
    const t = '(kicad_pcb (version 20240108))', head = new Uint8Array(2 + t.length * 2); head.set([255, 254]); for (let i = 0; i < t.length; i++) head[2 + i * 2] = t.charCodeAt(i);
    expect(sniffAny({ head, name: 'board.kicad_pcb', size: head.length }).format).toBe('kicad');
    // A scan reads min(size, SNIFF_BYTES) bytes; a shorter head would read as the start of a longer file.
    expect(sniffAny({ head: windowOf(65536, 0, 1, 255), name: 'firmware.bin', size: 65536 }).kind).toBe('firmware');
    expect(sniffAny({ head: windowOf(65535, 0, 1, 255), name: 'firmware.bin', size: 65535 }).kind).toBe('unknown');
  });
  it('is total on invalid input and throwing sniffers', () => {
    for (const input of [null, {}, { head: [], name: '', size: 0 }, { head: new Uint8Array(0), name: '', size: Infinity }]) expect(() => sniffAny(input as never)).not.toThrow();
    let seed = 23;
    for (let n = 0; n < 400; n++) {
      const head = new Uint8Array(n); for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; head[i] = seed & 255; }
      const result = sniffAny({ head, name: 'synthetic', size: n }); expect(result.confidence).toBeGreaterThanOrEqual(0); expect(result.confidence).toBeLessThanOrEqual(100);
    }
  });
});
