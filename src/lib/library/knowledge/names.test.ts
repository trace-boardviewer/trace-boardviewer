import { describe, expect, it } from 'vitest';
import { MAX_SEGMENTS, MAX_SEGMENT_LENGTH, analyzeName, analyzePath, pathSegments } from './names';

describe('path segments', () => {
  const rows: Array<[string, string[]]> = [
    ['a/b/c.brd', ['a', 'b', 'c.brd']], ['a\\b\\c.brd', ['a', 'b', 'c.brd']], ['/a//b/', ['a', 'b']], ['./a/./b', ['a', 'b']], ['../a/b', ['a', 'b']], ['c.brd', ['c.brd']], ['', []], ['/', []], ['\\\\server\\share\\x.brd', ['server', 'share', 'x.brd']],
    ['C:\\Boards\\Dell\\x.brd', ['C:', 'Boards', 'Dell', 'x.brd']], ['a/b\\c/d', ['a', 'b', 'c', 'd']],
  ];
  it.each(rows)('%j', (path, expected) => {
    expect(pathSegments(path)).toEqual(expected);
  });
  it('keeps the last segments of a deep path and cuts long segments', () => {
    const deep = Array.from({ length: 40 }, (_value, index) => `d${index}`).join('/');
    expect(pathSegments(deep)).toHaveLength(MAX_SEGMENTS);
    expect(pathSegments(deep)[MAX_SEGMENTS - 1]).toBe('d39');
    expect(pathSegments('x'.repeat(1000))[0]).toHaveLength(MAX_SEGMENT_LENGTH);
    expect(pathSegments(5 as unknown as string)).toEqual([]);
  });
});

describe('path analysis', () => {
  it('reads the board number, revision, vendor, device and document type of a file name', () => {
    const analysis = analyzePath('Repair/MacBook Pro 15 820-00875-A.brd');
    expect(analysis.best.boardNumber).toMatchObject({ shape: 'logic-board-820', normalized: '820-00875', revision: 'A' });
    expect(analysis.best.revision).toMatchObject({ normalized: 'A', basis: 'board-number' });
    expect(analysis.best.vendor?.id).toBe('apple');
    expect(analysis.best.device?.id).toBe('laptop');
    expect(analysis.best.documents.map(item => item.id)).toEqual(['board']);
    expect(analysis.extension).toBe('brd');
  });
  it('reads a number from a folder name and the revision from the file name', () => {
    const analysis = analyzePath('Dell/Latitude E7470/LA-C281P/schematic REV B.pdf');
    expect(analysis.best.boardNumber).toMatchObject({ shape: 'la-code', normalized: 'LA-C281P' });
    expect(analysis.boardNumbers[0].source).toBe('folder');
    expect(analysis.best.revision).toMatchObject({ normalized: 'B', basis: 'label' });
    expect(analysis.best.vendor?.id).toBe('dell');
    expect(analysis.best.documents.map(item => item.id)).toEqual(['schematic']);
    expect(analysis.extension).toBe('pdf');
  });
  it('reads archive names as archives and cuts their extension', () => {
    const analysis = analyzePath('Boards/NM-A481 Lenovo.zip/x/ThinkPad T480.brd');
    const sources = analysis.boardNumbers.map(item => item.source);
    expect(sources).toEqual(['archive']);
    expect(analysis.boardNumbers[0].value.normalized).toBe('NM-A481');
    expect(analysis.vendors.map(item => [item.value.id, item.source])).toEqual([['lenovo', 'archive'], ['lenovo', 'name']]);
  });
  it('prefers the file name when two segments tie', () => {
    const analysis = analyzePath('820-01234/820-05678.brd');
    expect(analysis.best.boardNumber?.normalized).toBe('820-05678');
  });
  it('keeps the segment index of each result', () => {
    const analysis = analyzePath('Apple/820-01234/x.brd');
    expect(analysis.boardNumbers.map(item => [item.segment, item.source])).toEqual([[1, 'folder']]);
    expect(analysis.vendors.map(item => [item.segment, item.source])).toEqual([[0, 'folder']]);
  });
  it('reads a folder named like a version as text', () => {
    const analysis = analyzePath('v2.5/board.brd');
    expect(analysis.revisions.map(item => [item.value.normalized, item.source])).toEqual([['V2.5', 'folder']]);
  });
  it('suggests nothing from a plain name', () => {
    const analysis = analyzePath('misc/notes.txt');
    expect(analysis.best.boardNumber).toBeUndefined();
    expect(analysis.best.revision).toBeUndefined();
    expect(analysis.best.vendor).toBeUndefined();
    expect(analysis.best.device).toBeUndefined();
    expect(analysis.best.documents).toEqual([]);
  });
  it('treats a bare file name as the file', () => {
    expect(analyzePath('LA-Z123P.pdf').boardNumbers[0].source).toBe('name');
  });
  it('is total', () => {
    for (const value of [undefined, null, 5, {}, [], '', ' ', '/', '\u0000'] as unknown[]) {
      const analysis = analyzePath(value as string);
      expect(analysis.boardNumbers).toEqual([]);
      expect(analysis.best.documents).toEqual([]);
    }
  });
  it('reads a single name', () => {
    const analysis = analyzeName('Compal LA-Z123P REV C schematic', 'name', 'pdf');
    expect(analysis.boardNumbers.map(item => item.value.normalized)).toEqual(['LA-Z123P']);
    expect(analysis.revisions.map(item => item.value.normalized)).toEqual(['C']);
    expect(analysis.vendors.map(item => item.value.id)).toEqual(['compal']);
    expect(analysis.documents.map(item => item.value.id)).toEqual(['schematic']);
    expect(analysis.documentsFromExtension).toEqual([]);
    expect(analyzeName('x', 'name', 'brd').documentsFromExtension.map(hint => hint.id)).toEqual(['board']);
  });
  it('reads the names of a library-like tree', () => {
    const rows: Array<[path: string, shape: string | undefined, vendor: string | undefined, document: string | undefined]> = [
      ['Apple/MacBook Pro/820-00875/820-00875-A.brd', 'logic-board-820', 'apple', 'board'],
      ['Apple/MacBook Pro/820-00875/051-9876.pdf', 'logic-board-820', 'apple', undefined],
      ['Lenovo/ThinkPad/NM-A481/NM-A481 schematic.pdf', 'nm-code', 'lenovo', 'schematic'],
      ['Samsung/Galaxy S21/SM-G991B/SM-G991B.zip', 'model-sm', 'samsung', undefined],
      ['Sony/PlayStation 4/CUH-1215A/boardview.brd', 'sony-console', 'sony', 'board'],
      ['Quanta/DA0X83MB6D0.bvr', 'da0-code', 'quanta', 'board'],
      ['Inventec/6050A2423701-MB-A02/6050A2423701.fz', 'inventec-6050a', 'inventec', 'board'],
      ['Wistron/48.4ZZ01.011.pdf', 'dotted-48', 'wistron', undefined],
      ['GPU/AMD Radeon/109-Z12345-00.brd', 'amd-109', 'amd', 'board'],
      ['docs/datasheet TPS51225.pdf', undefined, undefined, 'datasheet'],
      ['misc/photo 001.jpg', undefined, undefined, 'photo'],
      ['bios/820-01234 MLB.bin', 'logic-board-820', undefined, 'firmware'],
    ];
    for (const [path, shape, vendor, document] of rows) {
      const analysis = analyzePath(path);
      expect(analysis.best.boardNumber?.shape, path).toBe(shape);
      expect(analysis.best.vendor?.id, path).toBe(vendor);
      if (document !== undefined) expect(analysis.best.documents[0]?.id, path).toBe(document);
    }
  });
  it('counts a bounded number of steps per character', () => {
    const meter = { steps: 0 };
    const path = 'Apple/MacBook Pro 15/820-00875-A schematic REV B/820-00875-A.brd';
    analyzePath(path.repeat(1), { meter });
    expect(meter.steps).toBeLessThanOrEqual(80 * path.length);
  });
});
