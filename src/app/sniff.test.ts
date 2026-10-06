import { describe, expect, it } from 'vitest';
import { sniffDocument } from './sniff';
import prologCases from '../../tests/fixtures/xml-prolog-cases.json';

const enc = (value: string) => new TextEncoder().encode(value);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('sniffDocument (browser fallback, by bytes)', () => {
  it('recognizes PDF, PNG, JPEG, WebP and SVG by content', () => {
    expect(sniffDocument(enc('%PDF-1.7\n%\xe2\xe3'))).toEqual({ kind: 'pdf', format: 'pdf' });
    expect(sniffDocument(enc(`\n\n  garbage-before-header %PDF-1.4`))).toEqual({ kind: 'pdf', format: 'pdf' });
    expect(sniffDocument(PNG)).toEqual({ kind: 'image', format: 'png' });
    expect(sniffDocument(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]))).toEqual({ kind: 'image', format: 'jpeg' });
    expect(sniffDocument(Uint8Array.from([...enc('RIFF'), 1, 0, 0, 0, ...enc('WEBPVP8 ')]))).toEqual({ kind: 'image', format: 'webp' });
    expect(sniffDocument(enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'))).toEqual({ kind: 'image', format: 'svg' });
  });

  it('recognizes KiCad, legacy EESchema, its libraries and EAGLE schematics', () => {
    expect(sniffDocument(enc('(kicad_sch (version 20231120) (generator "x"))'))).toEqual({ kind: 'schematic', format: 'kicad_sch' });
    expect(sniffDocument(enc('﻿  (kicad_sch\n (version 20231120))'.replace('﻿', '')))).toEqual({ kind: 'schematic', format: 'kicad_sch' });
    expect(sniffDocument(enc('EESchema Schematic File Version 4\nEELAYER 30 0'))).toEqual({ kind: 'schematic', format: 'eeschema' });
    expect(sniffDocument(enc('EESchema-LIBRARY Version 2.4\n#encoding utf-8'))).toEqual({ kind: 'schematic', format: 'eeschema-lib' });
    expect(sniffDocument(enc('<?xml version="1.0" encoding="utf-8"?><eagle version="9.6.2"><drawing><schematic><sheets/></schematic></drawing></eagle>'))).toEqual({ kind: 'schematic', format: 'eagle' });
    // The XML prolog may open with a comment or a DOCTYPE, as the native sniffer allows.
    expect(sniffDocument(enc('<!-- exported -->\n<eagle version="9.6.2"><drawing><schematic><sheets/></schematic></drawing></eagle>'))).toEqual({ kind: 'schematic', format: 'eagle' });
    expect(sniffDocument(enc('<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2"><drawing><schematic><sheets/></schematic></drawing></eagle>'))).toEqual({ kind: 'schematic', format: 'eagle' });
    expect(sniffDocument(enc('<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ kind: 'image', format: 'svg' });
  });

  it('decides every prolog shape of the shared fixture set as the native document sniffer does', () => {
    for (const { label, text, root, bom } of prologCases as Array<{ label: string; text: string; root: string | null; bom?: boolean }>) {
      const data = bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...enc(text)]) : enc(text);
      const expected = root === 'svg' ? { kind: 'image', format: 'svg' } : root === 'eagle' ? { kind: 'schematic', format: 'eagle' } : null;
      expect(sniffDocument(data), label).toEqual(expected);
    }
  });

  it('refuses everything else: boards, libraries, HTML, binary noise, by extension-independent content', () => {
    expect(sniffDocument(enc('<?xml version="1.0"?><eagle version="9.6"><drawing><board/></drawing></eagle>'))).toBeNull();
    expect(sniffDocument(enc('(kicad_pcb (version 20240108))'))).toBeNull();
    expect(sniffDocument(enc('<!DOCTYPE html><html><svg></svg></html>'))).toBeNull();
    expect(sniffDocument(enc('$HEADER\nGENCAD 1.4'))).toBeNull();
    expect(sniffDocument(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBeNull();
    expect(sniffDocument(new Uint8Array(0))).toBeNull();
  });
});
