import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT_CAPABILITIES } from './formats';
import { SCHEMATIC_CAPABILITIES } from './schematic';
import { BOARD_EVIDENCE, SCHEMATIC_EVIDENCE, buildSupportMarkdown } from './support-table';

const FILE = path.join(process.cwd(), 'docs', 'SUPPORT.md');

describe('docs/SUPPORT.md', () => {
  it('matches the capability tables (regenerate with UPDATE_SUPPORT=1)', () => {
    const generated = buildSupportMarkdown();
    if (process.env.UPDATE_SUPPORT === '1') writeFileSync(FILE, generated);
    expect(readFileSync(FILE, 'utf8')).toBe(generated);
  });
  it('never labels a format "supported" without real-file validation and lists every family', () => {
    const text = buildSupportMarkdown();
    expect(text).toContain('draft (synthetic fixtures only)');
    for (const name of ['GenCAD 1.4', 'KiCad PCB', 'EAGLE board XML', 'Altium PcbDoc', 'KiCad schematic', 'KiCad legacy schematic', 'EAGLE schematic', 'TVW boardview']) expect(text, name).toContain(name);
    // Four rows are "supported" with real-file validation — GenCAD, BVRAW_FORMAT_3 (open Raspberry Pi Pico boardviews), KiCad PCB and EAGLE board XML (KiCad 9 demo, Antmicro Jetson Nano baseboard, Pico, SparkFun RedBoard).
    expect(text.match(/\| supported \|/g)?.length).toBe(2);
  });
});

// The real-file overlays (BOARD_EVIDENCE / SCHEMATIC_EVIDENCE) must stay attached to the rows they describe.
describe('real-file evidence overlays (KiCad, EAGLE, schematic readers)', () => {
  it('every overlay names an existing row, and every rewrite still matches exactly one note of its row', () => {
    for (const [id, evidence] of Object.entries(BOARD_EVIDENCE)) {
      const row = FORMAT_CAPABILITIES.find(c => c.id === id);
      expect(row, id).toBeDefined();
      for (const { from } of evidence.rewrites) expect(row!.notes.filter(note => note.includes(from)).length, `${id}: ${from.slice(0, 50)}`).toBe(1);
    }
    for (const [id, evidence] of Object.entries(SCHEMATIC_EVIDENCE)) {
      const row = SCHEMATIC_CAPABILITIES.find(c => c.id === id);
      expect(row, id).toBeDefined();
      for (const { from } of evidence.rewrites) expect(row!.limits.filter(note => note.includes(from)).length, `${id}: ${from.slice(0, 50)}`).toBe(1);
    }
    for (const row of SCHEMATIC_CAPABILITIES) expect(SCHEMATIC_EVIDENCE[row.id], row.id).toBeDefined();
  });
  it('shows KiCad PCB and EAGLE board as validated with real files, names the families, and no longer says no real file was tested', () => {
    const text = buildSupportMarkdown();
    for (const name of ['KiCad PCB', 'EAGLE board XML']) {
      const row = text.split('\n').find(line => line.startsWith(`| ${name} |`))!;
      expect(row, name).toContain('| validated with real files |');
      expect(row, name).not.toContain('draft (synthetic fixtures only)');
    }
    expect(text).toContain('real files: KiCad 9 demo (pic_programmer), Antmicro Jetson Nano baseboard (28 MB), Raspberry Pi Pico');
    expect(text).toContain('real files: SparkFun RedBoard (EAGLE 7.7 XML board; 35 MB EAGLE 7.5 production panel)');
    expect(text).not.toContain('no real KiCad file was tested');
    expect(text).not.toContain("previous author's reading");
    expect(text).toContain('Open gap, panels:');
    expect(text).toContain('synthetic fixtures only (no real legacy file was available)');
  });
});
