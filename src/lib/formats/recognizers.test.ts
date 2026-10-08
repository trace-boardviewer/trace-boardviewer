import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BoardFormatError } from './common';
import { expectBoundedWork, expectScaling } from '../../test-support/timing';
import { detectUnsupported, ipc2581, explainUnsupported, RECOGNIZER_IDS, recognizeUnsupported, UNVERIFIED_FAMILIES, type RecognizerId } from './recognizers';

// --- Original synthetic samples ------------------------------------------------------------------------------------------------
const enc = new TextEncoder();
const GERBER = '%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.0100*%\nG04 synthetic copper layer*\nD10*\nX010000Y010000D02*\nX020000Y010000D01*\nM02*\n';
const IPC = '<?xml version="1.0" encoding="UTF-8"?>\n<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">\n  <Content roleRef="Owner"/>\n</IPC-2581>\n';
const MENTOR = '# file : /synthetic/job/neutral_file.mech\n# date : Monday January 1, 2001; 10:00:00\n# \nB_UNITS INCH\n';
const SAMSUNG = '###Panel Added\nCOMP U1 100 200 0 TOP\nC_PIN U1 1 100 200 N1\n'; // read by samsung-cad.ts now; the recognizers must stay silent about it
const GENCAD = '$HEADER\nGENCAD 1.4\nUSER "synthetic"\nUNITS INCH\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n$SIGNALS\n$ENDSIGNALS\n';
const KICAD = '(kicad_pcb (version 20221018) (generator pcbnew)\n  (general (thickness 1.6))\n  (net 0 "")\n)\n';
const EAGLE = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2"><drawing><board><elements/></board></drawing></eagle>\n';

function allegro(magic = 0x00130400, marker = 'all', size = 4096): Uint8Array {
  const data = new Uint8Array(size);
  new DataView(data.buffer).setUint32(0, magic, true);
  data.set(enc.encode(marker), 0xf8);
  return data;
}
/** One ustar entry (header with a valid checksum, content padded to 512 bytes). */
function tarEntry(name: string, content: Uint8Array = new Uint8Array(0), options: { prefix?: string; breakChecksum?: boolean } = {}): Uint8Array {
  const header = new Uint8Array(512), put = (text: string, at: number) => header.set(enc.encode(text), at);
  put(name, 0); put('0000644\0', 100); put('0000000\0', 108); put('0000000\0', 116); put(content.length.toString(8).padStart(11, '0') + '\0', 124); put('00000000000\0', 136);
  put('        ', 148); put(content.length ? '0' : '5', 156); put('ustar\0' + '00', 257);
  if (options.prefix) put(options.prefix, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  if (options.breakChecksum) header[148] ^= 1;
  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512); padded.set(content);
  return join(header, padded);
}
function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const tar = (...entries: Uint8Array[]) => join(...entries, new Uint8Array(1024));
const tgz = (...entries: Uint8Array[]) => gzipSync(tar(...entries));
const ODB_TGZ = () => tgz(tarEntry('odb/'), tarEntry('odb/matrix/'), tarEntry('odb/matrix/matrix', enc.encode('STEP {\n}\n')), tarEntry('odb/steps/pcb/layers/top/features', enc.encode('UNITS=INCH\n')));
function prng(seed: number) { let state = seed >>> 0 || 1; return () => (state = (state ^ state << 13) >>> 0, state = (state ^ state >>> 17) >>> 0, state = (state ^ state << 5) >>> 0, state / 2 ** 32); }

const POSITIVE: Array<[RecognizerId, string, Uint8Array]> = [
  ['allegro-brd', 'Allegro header', allegro()],
  ['gerber', 'Gerber', enc.encode(GERBER)], ['mentor-neutral', 'Mentor neutral', enc.encode(MENTOR)],
];
const random = prng(0x5eed);
const NEGATIVE: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)], ['one byte', Uint8Array.from([0x25])], ['plain text', enc.encode('hello world\nthis is not a board\n')], ['GenCAD', enc.encode(GENCAD)], ['KiCad', enc.encode(KICAD)], ['EAGLE XML', enc.encode(EAGLE)],
  ['random bytes', Uint8Array.from({ length: 8192 }, () => Math.floor(random() * 256))], ['zeros', new Uint8Array(4096)], ['PDF', enc.encode('%PDF-1.7\n%âãÏÓ\n')], ['JSON', enc.encode('{"FS":"%FSLAX24Y24*%"}')],
  ['Altium ASCII', enc.encode('|RECORD=Board|KIND=Protel_Advanced_PCB|VX0=0mil\n')], ['OLE magic', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(600)])],
  ['XML other root', enc.encode('<?xml version="1.0"?>\n<project><IPC-2581x/></project>\n')], ['IPC text mention', enc.encode('This document discusses <IPC-2581 revision="B"> files.\n')],
  ['Excellon drill', enc.encode('M48\nMETRIC\nT01C0.8\n%\nT01\nX1000Y2000\nM30\n')], ['Gerber format only', enc.encode('%FSLAX24Y24*%\nnothing else\n')], ['Gerber without format', enc.encode('%MOIN*%\n%ADD10C,0.01*%\nM02*\n')],
  ['Samsung marker only', enc.encode('###Panel Added\nsome text\n')], ['Samsung CAD (readable now, never a recognizer)', enc.encode(SAMSUNG)], ['COMP only', enc.encode('COMP U1 1 2\nC_PIN U1 1\n')], ['Mentor file only', enc.encode('# file : x\nplain\nplain\n')],
  ['gzip of text', gzipSync(enc.encode('hello gzip world\n'.repeat(100)))], ['gzip tar without ODB entries', tgz(tarEntry('docs/'), tarEntry('docs/readme.txt', enc.encode('hi')))],
  ['tar entry steps.txt', tgz(tarEntry('steps.txt', enc.encode('x')), tarEntry('matrixes/matrix2', enc.encode('x')))], ['ODB with broken checksum', tgz(tarEntry('odb/matrix/matrix', enc.encode('x'), { breakChecksum: true }))],
  ['plain tar (uncompressed ODB)', tar(tarEntry('odb/matrix/matrix', enc.encode('x')))], ['truncated gzip header', ODB_TGZ().subarray(0, 12)], ['gzip magic only', Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])],
  ['Allegro magic without marker', allegro(0x00130400, '\0\0\0')], ['Allegro marker with unknown magic', allegro(0x12345600)], ['Allegro vie marker', allegro(0x00130400, 'vie')],
  ['Allegro big-endian magic', (() => { const data = allegro(); new DataView(data.buffer).setUint32(0, 0x00130400, false); return data; })()], ['Allegro too short', allegro().subarray(0, 0xfa)],
];

describe('recognizeUnsupported', () => {
  it('exposes the detected families and names the family without a verifiable signature', () => {
    expect([...RECOGNIZER_IDS].sort()).toEqual(['allegro-brd', 'gerber', 'mentor-neutral']);
    expect(UNVERIFIED_FAMILIES).toEqual([]);
  });

  it.each(POSITIVE)('%s: %s throws UNSUPPORTED_VARIANT with its capability id and never returns a board', (id, _label, data) => {
    expect(detectUnsupported(data)?.id).toBe(id);
    try { recognizeUnsupported({ name: 'sample.bin', data }); throw new Error('returned instead of throwing'); }
    catch (error) {
      expect(error).toBeInstanceOf(BoardFormatError);
      expect(error).toMatchObject({ code: 'UNSUPPORTED_VARIANT', format: id });
      expect((error as Error).message.length).toBeGreaterThan(60);
    }
  });

  it('gives each family a precise explanation', () => {
    const message = (data: Uint8Array) => explainUnsupported(detectUnsupported(data)!);
    expect(message(allegro(0x00141500))).toMatch(/Allegro native board database \(\.brd, format 17\.5\).*GenCAD/);
    expect(message(allegro(0x00150037))).toMatch(/format 18\.0 or newer/);
    expect(detectUnsupported(ODB_TGZ())).toBeNull(); // registered reader owns this family
    expect(detectUnsupported(enc.encode(IPC))).toBeNull(); // registered reader owns this family
    expect(message(enc.encode(GERBER))).toMatch(/Gerber RS-274X layer detected \(units: inches\).*no components, pins or nets/);
    expect(message(enc.encode(GERBER.replace('%MOIN*%', '%MOMM*%')))).toMatch(/units: millimeters/);
    expect(message(enc.encode(MENTOR))).toMatch(/Mentor Graphics neutral file/);
  });

  it.each(NEGATIVE)('does not recognize %s', (_label, data) => {
    expect(detectUnsupported(data)).toBeNull();
    expect(recognizeUnsupported({ name: 'sample.cad', data })).toBeNull();
  });

  it('never misfires on a GenCAD file, even one that mentions the other families markers', () => {
    const noisy = GENCAD + '$TEXT\n###Panel Added\nCOMP U1\nC_PIN U1 1\n# file : x\n# date : y\n$ENDTEXT\n';
    expect(detectUnsupported(enc.encode(noisy))).toBeNull();
    // Either GenCAD marker alone is enough to keep the file away from the other families; each removal must really change the text.
    const withoutHeaderKeyword = noisy.replace('$HEADER\n', ''), withoutVersionLine = noisy.replace('GENCAD 1.4\n', '');
    expect(withoutHeaderKeyword).not.toBe(noisy);
    expect(withoutVersionLine).not.toBe(noisy);
    expect(detectUnsupported(enc.encode(withoutHeaderKeyword))).toBeNull();
    expect(detectUnsupported(enc.encode(withoutVersionLine))).toBeNull();
    expect(recognizeUnsupported({ name: 'board.cad', data: enc.encode(noisy) })).toBeNull();
  });

  it('screens a head of blank lines in linear time, and a GenCAD keyword that starts a line (after blanks) still vetoes the Mentor rule', () => {
    // The scanned head is at most 64 KiB. Ascending sizes: a guard whose blank run crosses line breaks needs about 0.4 s for 16 KiB and 6 s for 64 KiB, so a regression fails at the first pair.
    const heads: Array<[string, (size: number) => string]> = [['blank lines', size => '\n'.repeat(size)], ['lines of one space', size => ' \n'.repeat(size / 2)], ['CRLF blank lines', size => '\r\n'.repeat(size / 2)], ['indented blank lines', size => '  \t\n'.repeat(size / 4)]];
    for (const [label, head] of heads) expectScaling(label, [4096, 16_384, 65_536], size => { const data = enc.encode(head(size)); return () => detectUnsupported(data); });
    for (const size of [4096, 16_384, 65_536]) for (const [label, head] of heads) expect(detectUnsupported(enc.encode(head(size))), `${size}: ${label}`).toBeNull();
    const mentor = '# file : a\n# date : b\n';
    expect(detectUnsupported(enc.encode(mentor))?.id).toBe('mentor-neutral');
    for (const veto of ['$HEADER\n', '  \t$HEADER\n', '\n\n   \n$header\n', 'GENCAD 1.4\n', '\n \n\t gencad\t1.4\n', '$HEADER']) expect(detectUnsupported(enc.encode(mentor + veto)), JSON.stringify(veto)).toBeNull();
    for (const noVeto of ['x $HEADER\n', '$HEADERS\n', '$HEADER_\n', 'GENCADx\n', 'GENCAD', '# $HEADER\n', '\n  x\n  $HEADERS\n']) expect(detectUnsupported(enc.encode(mentor + noVeto))?.id, JSON.stringify(noVeto)).toBe('mentor-neutral');
  });

  it('accepts harmless variations: CRLF, BOM, optional XML declaration, comments and DOCTYPE before the IPC root', () => {
    const asBytes = (text: string) => enc.encode(text);
    expect(ipc2581(IPC.replace(/\n/g, '\r\n'))).toMatchObject({ id: 'ipc2581', detail: 'C' });
    expect(ipc2581('﻿' + IPC)?.id).toBe('ipc2581');
    expect(ipc2581('<IPC-2581 revision="B"/>')).toMatchObject({ id: 'ipc2581', detail: 'B' });
    expect(ipc2581('<IPC-2581>\n</IPC-2581>')).toMatchObject({ id: 'ipc2581' });
    expect(ipc2581('  \n<!-- exported -->\n<!DOCTYPE IPC-2581>\n<IPC-2581 revision="C">')?.id).toBe('ipc2581');
    expect(ipc2581(IPC.replace('revision="C"', 'revision="<script>"'))).toMatchObject({ id: 'ipc2581', detail: undefined });
    expect(detectUnsupported(asBytes(GERBER.replace(/\n/g, '\r\n')))?.id).toBe('gerber');
    expect(detectUnsupported(asBytes('%TF.GenerationSoftware,Synthetic,Test,1*%\n%FSLAX36Y36*%\n%MOMM*%\nG04 x*\n'))).toMatchObject({ id: 'gerber', detail: 'MM' });
    expect(detectUnsupported(asBytes('G04 leading comment*\n%FSTIX25Y25*%\n%ADD11R,0.5X0.5*%\nM02*'))?.id).toBe('gerber');
    expect(detectUnsupported(asBytes(MENTOR.replace(/\n/g, '\r\n')))?.id).toBe('mentor-neutral');
    expect(detectUnsupported(asBytes('﻿# file : a\n# comment\n# date : b\n'))?.id).toBe('mentor-neutral');
  });

  it('allegro: recognizes every documented magic with the lower byte masked and requires the "all" marker', () => {
    const versions: Array<[number, string]> = [[0x00130000, '16.0'], [0x00130400, '16.2'], [0x00130c00, '16.4'], [0x00131000, '16.5'], [0x00131500, '16.6'], [0x00140400, '17.2'], [0x00140900, '17.4'], [0x00141500, '17.5'], [0x00150000, '18.0 or newer']];
    for (const [magic, version] of versions) {
      expect(detectUnsupported(allegro(magic))).toMatchObject({ id: 'allegro-brd', detail: version });
      expect(detectUnsupported(allegro(magic | 0xff))?.detail).toBe(version);
      expect(detectUnsupported(allegro(magic, 'ALL'))).toBeNull();
    }
    expect(detectUnsupported(allegro(0x00130400, 'all', 0x100))?.id).toBe('allegro-brd');
    expect(detectUnsupported(allegro(0x00130400, 'all', 0xff))).toBeNull();
    expect(detectUnsupported(allegro(0x00130500))).toBeNull(); // a mask on the lower byte only: 0x0500 is not a documented value
  });

  it('scans a bounded prefix: a marker after 64 KiB is ignored and huge unrelated text is cheap', () => {
    const pad = 'x'.repeat(70 * 1024) + '\n';
    expect(detectUnsupported(enc.encode(pad + IPC))).toBeNull();
    expect(detectUnsupported(enc.encode(pad + MENTOR))).toBeNull();
    // Only the head is read: the time does not grow with the text, whatever its size (1,000,000 lines are 27 MB).
    expectBoundedWork('unrelated text', [62_500, 250_000, 1_000_000], lines => { const data = enc.encode('lorem ipsum dolor sit amet\n'.repeat(lines)); return () => detectUnsupported(data); });
    expect(detectUnsupported(enc.encode('lorem ipsum dolor sit amet\n'.repeat(1_000_000)))).toBeNull();
    // A Gerber layer whose only second marker is the M02 end statement in the tail of a large file is still recognized.
    const large = enc.encode('%FSLAX24Y24*%\n' + 'X010000Y010000D01*\n'.repeat(10_000) + 'M02*\n');
    expect(detectUnsupported(large)?.id).toBe('gerber');
  });

  it('scans a prolog of many empty XML comments in linear time and keeps the result unchanged', () => {
    const emptyComments = (count: number) => '<!---->'.repeat(count);
    const detect = (text: string) => ipc2581(text);
    // Ascending sizes: a backtracking regex needs seconds for 26 comments and never finishes 40 (the test then ends at its time limit), so a regression fails early and loudly.
    const sizes = [26, 104, 416, 1170];
    expectScaling('comments and no root', sizes, count => { const text = emptyComments(count) + '\n'; return () => ipc2581(text); });
    const claimedSizes = [26, 104, 416, 1000]; // the root must start within the 8 KiB that are read
    expectScaling('comments before the root', claimedSizes, count => { const text = emptyComments(count) + '<IPC-2581 revision="C">'; return () => ipc2581(text); });
    // The same through the dispatcher entry point, as a board file with an accepted extension would arrive.
    expectScaling('comments through the entry point', sizes, count => { const data = enc.encode(emptyComments(count) + '\n'); return () => recognizeUnsupported({ name: 'board.xml', data }); });
    for (const count of claimedSizes) expect(detect(emptyComments(count) + '<IPC-2581 revision="C">'), `${count} comments before the root`).toMatchObject({ id: 'ipc2581', detail: 'C' });
    for (const count of sizes) {
      expect(detect(emptyComments(count) + '\n'), `${count} comments`).toBeNull();
      expect(recognizeUnsupported({ name: 'board.xml', data: enc.encode(emptyComments(count) + '\n') }), `${count} comments through the entry point`).toBeNull();
    }
    // Comments around a DOCTYPE, and other long runs that have no closing marker, are linear too (the scan reads at most the first 8 KiB, so the largest size fills it).
    const shapes: Array<[string, (count: number) => string, number[], string | null]> = [
      ['comments around a DOCTYPE', count => emptyComments(count) + '<!DOCTYPE IPC-2581>' + emptyComments(count) + '<IPC-2581 revision="B">', [31, 125, 500], 'B'],
      ['alternating DOCTYPE and comments', count => ('<!DOCTYPE a>' + emptyComments(1)).repeat(count) + '\n', [27, 108, 430], null],
      ['unterminated comments', count => '<!-- '.repeat(count), [100, 400, 1600], null],
      ['dashes without a closing marker', count => '<!--' + '-'.repeat(count), [500, 2000, 8000], null],
      ['comments separated by whitespace', count => '<!-- a -->\n  '.repeat(count) + 'x', [37, 150, 600], null],
    ];
    for (const [label, text, counts] of shapes) expectScaling(label, counts, count => { const input = text(count); return () => ipc2581(input); });
    for (const [label, text, counts, revision] of shapes) {
      const result = detect(text(counts[counts.length - 1]));
      expect(result?.detail ?? null, label).toBe(revision);
      expect(result === null, label).toBe(revision === null);
    }
  });

  it('keeps the prolog rules: a comment ends at its first closing marker and cannot hide or fake the root', () => {
    const detect = (text: string) => ipc2581(text)?.id ?? null;
    expect(detect('<!-- a --- b -->\n<IPC-2581 revision="B">')).toBe('ipc2581');
    expect(detect('<!--a--->\n<IPC-2581 revision="B">')).toBe('ipc2581');
    expect(detect('<!-- a -> b -->\n<IPC-2581 revision="B">')).toBe('ipc2581'); // a single dash before ">" is plain text
    expect(detect('<!-- a -- b -->\n<IPC-2581 revision="B">')).toBe('ipc2581'); // so is a run of dashes that something else follows
    expect(detect('<!---->\n<IPC-2581 revision="B">')).toBe('ipc2581');
    expect(detect('<!-->\n<IPC-2581 revision="B">')).toBeNull(); // "<!-->" and "<!--->" do not close themselves
    expect(detect('<!--->\n<IPC-2581 revision="B">')).toBeNull();
    expect(detect('<?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE IPC-2581>\n<!-- b -->\n<IPC-2581 revision="B">')).toBe('ipc2581');
    expect(detect('<!-- <IPC-2581 revision="B"> -->\n<project/>')).toBeNull();
    expect(detect('<!-- unterminated\n<IPC-2581 revision="B">')).toBeNull();
    expect(detect('<!-- a -->\n<project/>\n<!-- b -->\n<IPC-2581 revision="B">')).toBeNull();
    expect(detect('<!DOCTYPE a><!DOCTYPE b>\n<IPC-2581 revision="B">')).toBeNull();
    expect(detect('<IPC-25810 revision="B">')).toBeNull();
  });

  it('does not decode binary files as text families', () => {
    const binary = Uint8Array.from([0, 1, 2, 3, ...enc.encode(GERBER)]);
    expect(detectUnsupported(binary)).toBeNull();
    expect(detectUnsupported(Uint8Array.from([0xff, 0xfe, ...[...IPC].flatMap(char => [char.charCodeAt(0), 0])]))).toBeNull(); // UTF-16 is not recognized
  });

  it('ignores non-byte input without throwing', () => {
    expect(recognizeUnsupported({ name: 'x', data: undefined as unknown as Uint8Array })).toBeNull();
  });
});
