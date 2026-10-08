import { describe, expect, it } from 'vitest';
import * as api from './index';
import { fingerprintOfFile, readPdfText, configurePdfForTests } from './read-back';
import { jaccard, pinSetOf } from './board-model';

describe('sample families', () => {
  it('make a board in several revisions and formats, each with a schematic, that the application reads back', async () => {
    configurePdfForTests();
    const family = api.sampleFamily({ seed: 'sample', revisions: 3, parts: 70 });
    expect(family.revisions.map(revision => revision.label)).toEqual(['A', 'B', 'C']);
    for (const revision of family.revisions) {
      expect(revision.boardFiles.map(file => file.format)).toEqual(api.boardWriters().map(writer => writer.id));
      for (const file of revision.boardFiles) expect(await fingerprintOfFile(file.format, file.name, file.bytes), `${revision.label} ${file.format}`).toBe(file.fingerprint);
      const { text } = await readPdfText(revision.schematic.bytes);
      expect(text[0]).toContain(family.boardNumber);
      expect(text[0]).toContain(`REV\n${revision.label}`);
    }
    const [first, second] = family.revisions;
    expect(first.boardFiles[0].fingerprint).not.toBe(second.boardFiles[0].fingerprint);
    expect(jaccard(pinSetOf(first.board), pinSetOf(second.board))).toBeGreaterThan(0.9);
  }, 60_000);

  it('are repeatable, and follow the options', () => {
    const a = api.sampleFamily({ seed: 1, formats: ['bvr', 'kicad'], shape: 'logic-board-820', titleBlockId: false, headerId: false, revisions: 1 });
    const b = api.sampleFamily({ seed: 1, formats: ['bvr', 'kicad'], shape: 'logic-board-820', titleBlockId: false, headerId: false, revisions: 1 });
    expect(a.boardNumber).toMatch(/^820-\d{5}$/);
    expect(a.revisions).toHaveLength(1);
    expect(a.revisions[0].boardFiles.map(file => file.format)).toEqual(['bvr', 'kicad']);
    expect(Buffer.from(a.revisions[0].boardFiles[1].bytes).equals(Buffer.from(b.revisions[0].boardFiles[1].bytes))).toBe(true);
    expect(a.revisions[0].schematic.titleIds).toEqual([]);
    expect(new TextDecoder().decode(a.revisions[0].boardFiles[1].bytes)).not.toContain(a.boardNumber);
    expect(api.sampleFamily({ seed: 2, formats: ['bvr'] }).boardNumber).not.toBe(api.sampleFamily({ seed: 3, formats: ['bvr'] }).boardNumber);
  });

  it('are available from the folder\'s index together with the generator and the metrics', () => {
    for (const name of ['generateMemoryLibrary', 'generateLibrary', 'sampleFamily', 'scoreResult', 'checkTargets', 'checkTruth', 'checkFiles', 'oracleResult', 'resolveOptions', 'GROUND_TRUTH_SCHEMA']) expect(Object.keys(api), name).toContain(name);
  });
});
