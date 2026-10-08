/*
 * Structure hooks of the text formats (original TRACE module, MIT). Each hook reads the layout the matching reader expects:
 * section markers, record keywords, field counts and the header facts that decide units, and nothing else (see ./structure.ts
 * for what a sink accepts). Keywords are the formats' own public vocabulary; they are counted, never values.
 */
import { decodeBdv, indexOfAscii } from '../formats/bdv';
import { tokens } from '../formats/common';
import { genCadStorageText } from '../formats/gencad-framing';
import { log2Ceil, NO_SECTION } from './report';
import { safeText, textLines, type StructureHook, type StructureInput, type StructureSink } from './structure';

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
/** Field count of a whitespace-separated record; quoted fields count once (GenCAD, BRD). */
const quotedFields = (line: string): number => tokens(line).length;

// --- GenCAD 1.4 ----------------------------------------------------------------------------------------------------------------------
const GENCAD_SECTIONS = ['HEADER', 'BOARD', 'PADS', 'PADSTACKS', 'SHAPES', 'COMPONENTS', 'DEVICES', 'SIGNALS', 'TRACKS', 'LAYERS', 'ROUTES', 'MECH', 'TESTPINS', 'POWERPINS', 'PSEUDOS', 'CHANGES', 'ARTWORKS', 'FIDUCIALS'];
const GENCAD_RECORDS = [
  'GENCAD', 'USER', 'DRAWING', 'REVISION', 'UNITS', 'ORIGIN', 'INTERTRACK', 'LINE', 'ARC', 'CIRCLE', 'RECTANGLE', 'FILLED', 'PAD', 'PADSTACK', 'SHAPE', 'INSERT',
  'HEIGHT', 'PIN', 'FIDUCIAL', 'COMPONENT', 'DEVICE', 'PLACE', 'LAYER', 'ROTATION', 'MIRROR', 'FLIP', 'PART', 'TYPE', 'STYLE', 'PACKAGE', 'VALUE', 'TOL', 'NTOL',
  'PTOL', 'VOLTS', 'PINCOUNT', 'PINDESC', 'PINFUNCT', 'PULL', 'SIGNAL', 'NODE', 'TRACK', 'ROUTE', 'VIA', 'TESTPAD', 'TESTPIN', 'ATTRIBUTE', 'ARTWORK', 'TEXT',
  'SHEET', 'PLANE', 'POLYGON', 'CUTOUT', 'MASK', 'LAYERSET', 'DRILL', 'WIDTH', 'SHAPEMODE',
];
export const gencadHook: StructureHook = {
  id: 'gencad', kind: 'text', steps: ['header'],
  keywords: [...GENCAD_SECTIONS.flatMap(name => [`$${name}`, `$END${name}`]), ...GENCAD_RECORDS],
  collect(input, sink) {
    let data: Uint8Array;
    try { data = genCadStorageText(input.data) ?? input.data; } catch { return; }
    const text = safeText(data);
    if (text === null) return;
    sink.padAngle('relative'); // stack, shape pin and placement angles are composed
    sink.section(NO_SECTION);
    let inHeader = false, sawHeader = false, version: string | undefined, unitsOk = false;
    for (const raw of textLines(text)) {
      const line = raw.trim();
      sink.line(raw);
      if (!line) continue;
      const first = line.split(/\s+/, 1)[0];
      if (first.startsWith('$')) {
        sink.keyword(first);
        if (first.startsWith('$END')) { sink.section(NO_SECTION); inHeader = false; }
        else { sink.section(first); inHeader = first === '$HEADER'; sawHeader ||= inHeader; }
        continue;
      }
      const fields = tokens(line);
      sink.keyword(first, fields.length);
      if (!inHeader) continue;
      if (first === 'GENCAD') version = fields[1];
      if (first === 'UNITS') {
        const unit = (fields[1] ?? '').toUpperCase();
        if (unit === 'MM') { sink.units('mm', 1); sink.code('unitCode', 1); unitsOk = true; }
        else if (unit === 'INCH') { sink.units('inch', 25.4); sink.code('unitCode', 2); unitsOk = true; }
        else if (unit === 'THOU') { sink.units('thou', 0.0254); sink.code('unitCode', 3); unitsOk = true; }
        else if (unit === 'MIL' || unit === 'MILS') { sink.units('mil', 0.0254); sink.code('unitCode', 4); unitsOk = true; }
        else if (unit === 'USER') {
          const perInch = Number(fields[2]);
          sink.code('unitCode', 5);
          if (Number.isFinite(perInch) && perInch >= 1e-6) { sink.units('user', 25.4 / perInch); unitsOk = true; } else sink.units('user');
        }
      }
    }
    if (version !== undefined && /^\d{1,3}(?:\.\d{1,3})?$/.test(version)) sink.code('version', Math.round(Number(version) * 10));
    sink.variant(version === '1.4' ? 'gencad-1.4' : 'gencad-other');
    if (sawHeader && version === '1.4' && unitsOk) sink.reached('header');
  },
};

// --- Landrex / TestLink BRD and TOPTEST BRD2 -------------------------------------------------------------------------------------------
const BRD_ENCODED = [0x23, 0xe2, 0x63, 0x28];
const LANDREX_HEADINGS = /^(str_length|var_data|Format|format|Parts|Pins1|Pins|Pins2|Nails):$/;
const BRD2_HEADING = /^(BRDOUT|NETS|PARTS|PINS|NAILS):\s*(.*)$/;
const BRD2_COUNTS = { BRDOUT: 'declaredOutlinePoints', NETS: 'declaredNets', PARTS: 'declaredParts', PINS: 'declaredPins', NAILS: 'declaredNails' } as const;
export const brdHook: StructureHook = {
  id: 'brd', kind: 'text', steps: ['header'],
  keywords: ['str_length:', 'var_data:', 'Format:', 'format:', 'Parts:', 'Pins1:', 'Pins:', 'Pins2:', 'Nails:', 'BRDOUT:', 'NETS:', 'PARTS:', 'PINS:', 'NAILS:'],
  collect(input, sink) {
    const encoded = BRD_ENCODED.every((byte, index) => input.data[index] === byte);
    const bytes = encoded ? input.data.map(byte => byte === 0 || byte === 10 || byte === 13 ? byte : ~((byte >>> 6) | (byte << 2)) & 0xff) : input.data;
    const text = safeText(bytes);
    if (text === null) return;
    sink.units('mil', 0.0254); sink.padAngle('none');
    const brd2 = !encoded && /^[ \t]*BRDOUT:/m.test(text);
    sink.variant(brd2 ? 'brd2' : encoded ? 'brd-landrex-encoded' : 'brd-landrex');
    sink.section(NO_SECTION);
    const seen = new Set<string>();
    let section = '', varData = 0, varDataOk = false;
    for (const raw of textLines(text)) {
      const line = raw.trim();
      sink.line(raw);
      if (!line) continue;
      const brd2Heading = brd2 ? BRD2_HEADING.exec(line) : null;
      if (brd2Heading) {
        const name = brd2Heading[1] as keyof typeof BRD2_COUNTS, rest = tokens(brd2Heading[2]);
        section = `${name}:`; seen.add(name);
        sink.keyword(section, rest.length); sink.section(section);
        const declared = Number(rest[0]);
        if (Number.isSafeInteger(declared) && declared >= 0) sink.count(BRD2_COUNTS[name], declared);
        if (name === 'BRDOUT' && rest.length === 3) {
          const width = Math.abs(Number(rest[1])), height = Math.abs(Number(rest[2]));
          if (Number.isFinite(width)) sink.code('declaredWidthLog2', log2Ceil(width));
          if (Number.isFinite(height)) sink.code('declaredHeightLog2', log2Ceil(height));
        }
        continue;
      }
      const landrex = brd2 ? null : LANDREX_HEADINGS.exec(line);
      if (landrex) { section = `${landrex[1]}:`; seen.add(landrex[1]); sink.keyword(section); sink.section(section); continue; }
      const fields = tokens(line);
      sink.row(fields.length);
      if (section === 'var_data:' && ++varData === 1 && fields.length === 4) {
        const counts = fields.map(Number);
        if (counts.every(value => Number.isSafeInteger(value) && value >= 0)) {
          varDataOk = true;
          sink.count('declaredOutlinePoints', counts[0]); sink.count('declaredParts', counts[1]); sink.count('declaredPins', counts[2]); sink.count('declaredNails', counts[3]);
        }
      }
    }
    if (brd2 ? ['BRDOUT', 'NETS', 'PARTS', 'PINS'].every(name => seen.has(name)) : varDataOk && seen.has('str_length')) sink.reached('header');
  },
};

// --- Honhan BDV, ASC trio and BVR -------------------------------------------------------------------------------------------------
const MARKER = /^<<[^<>]{1,64}>>$/;
const markerWord = (marker: string, known: readonly string[]) => (known.includes(marker) ? marker : '<<other>>');
const ASC_MARKERS = ['<<format.asc>>', '<<pins.asc>>', '<<nails.asc>>'];
/** Marker-delimited text: "<<name>>" lines open sections, "Part <ref> <side>" lines are keyword records, every other line is a row. */
function markerSections(text: string, sink: StructureSink, known: readonly string[]): Set<string> {
  const seen = new Set<string>();
  sink.section(NO_SECTION);
  for (const raw of textLines(text)) {
    const line = raw.trim();
    sink.line(raw);
    if (!line) continue;
    if (MARKER.test(line)) { const word = markerWord(line, known); seen.add(word); sink.keyword(word); sink.section(word); continue; }
    if (/^Part\s/.test(line)) { sink.keyword('Part', words(line).length); continue; }
    sink.row(words(line).length);
  }
  return seen;
}
export const bdvHook: StructureHook = {
  id: 'bdv', kind: 'text', steps: ['header'],
  keywords: [...ASC_MARKERS, '<<other>>', 'Part'],
  collect(input, sink) {
    const encoded = indexOfAscii(input.data, 'dd:1.3?,r?-=bb') >= 0 || indexOfAscii(input.data, 'dd2?74-r?-=bb') >= 0;
    const text = safeText(encoded ? decodeBdv(input.data) : input.data);
    if (text === null) return;
    sink.variant(encoded ? 'bdv-encoded' : 'bdv-plain'); sink.units('inch', 25.4); sink.padAngle('none');
    const seen = markerSections(text, sink, ASC_MARKERS);
    if ((seen.has('<<format.asc>>') || seen.has('<<nails.asc>>')) && seen.has('<<pins.asc>>')) sink.reached('header');
  },
};

const ASC_ROLES = ['format.asc', 'pins.asc', 'nails.asc'];
export const ascHook: StructureHook = {
  id: 'asc', kind: 'text', steps: ['header'],
  keywords: [...ASC_ROLES, 'Part'],
  collect(input, sink) {
    sink.variant('asc-trio'); sink.units('inch', 25.4); sink.padAngle('none');
    const files = new Map<string, Uint8Array>();
    if (input.companionRole && ASC_ROLES.includes(input.companionRole)) files.set(input.companionRole, input.data);
    for (const [name, bytes] of Object.entries(input.companions)) if (ASC_ROLES.includes(name) && !files.has(name)) files.set(name, bytes);
    if (input.companionRole === '@format.asc') files.set('format.asc', input.data);
    else if (!files.has('format.asc') && input.companions['@format.asc']) files.set('format.asc', input.companions['@format.asc']);
    sink.count('companionFiles', Object.keys(input.companions).length);
    let complete = true;
    for (const role of ASC_ROLES) {
      const bytes = files.get(role), text = bytes ? safeText(bytes) : null;
      if (text === null) { complete = false; continue; }
      sink.keyword(role); sink.section(role);
      let lines = 0;
      for (const raw of textLines(text)) {
        const line = raw.trim();
        sink.line(raw); lines++;
        if (!line) continue;
        if (/^Part\s/.test(line)) sink.keyword('Part', words(line).length); else sink.row(words(line).length);
      }
      if (lines < (role === 'nails.asc' ? 7 : 8)) complete = false;
    }
    if (complete) sink.reached('header');
  },
};

const BVR_SIGNATURE = /^[ \t]*BVRAW_FORMAT_(\d{1,9})(?![A-Za-z0-9_])/m;
const BVR3_KEYWORDS = [
  'PART_NAME', 'PART_SIDE', 'PART_ORIGIN', 'PART_MOUNT', 'PART_END', 'PART_OUTLINE_RELATIVE', 'PIN_ID', 'PIN_NUMBER', 'PIN_NAME', 'PIN_SIDE', 'PIN_ORIGIN', 'PIN_RADIUS',
  'PIN_NET', 'PIN_TYPE', 'PIN_COMMENT', 'PIN_OUTLINE_RELATIVE', 'PIN_END', 'OUTLINE_POINTS', 'OUTLINE_SEGMENTED',
];
const BVR1_MARKERS = ['<<Layout>>', '<<Pin>>', '<<Nail>>'];
export const bvrHook: StructureHook = {
  id: 'bvr', kind: 'text', steps: ['header'],
  keywords: ['BVRAW_FORMAT_1', 'BVRAW_FORMAT_3', ...BVR3_KEYWORDS, ...BVR1_MARKERS, '<<other>>'],
  collect(input, sink) {
    const text = safeText(input.data);
    if (text === null) return;
    const version = Number(BVR_SIGNATURE.exec(text)?.[1] ?? NaN);
    // A format version is a small number; anything larger is not a version and is not reported (nine digits of a file would be a channel for content).
    if (Number.isSafeInteger(version) && version <= 999) sink.code('version', version);
    sink.padAngle('none');
    if (version === 1) {
      sink.variant('bvr1'); sink.units('inch', 25.4);
      const seen = markerSections(text, sink, BVR1_MARKERS);
      for (const raw of textLines(text)) if (raw.trim() === 'BVRAW_FORMAT_1') { sink.keyword('BVRAW_FORMAT_1'); break; }
      if (seen.has('<<Pin>>')) sink.reached('header');
      return;
    }
    sink.variant(version === 3 ? 'bvr3' : 'bvr-other');
    if (version === 3) sink.units('mil', 0.0254);
    for (const raw of textLines(text)) {
      const line = raw.trim();
      if (!line) { sink.line(raw); continue; }
      const keyword = line.split(/\s+/, 1)[0];
      // Each record type is its own section, so that level 2 shows the first 32 lines of every record type.
      sink.section(keyword);
      sink.keyword(keyword, words(line).length - 1);
      sink.line(raw);
    }
    if (version === 3) sink.reached('header');
  },
};

// --- Samsung CAD ------------------------------------------------------------------------------------------------------------------------
export const samsungCadHook: StructureHook = {
  id: 'samsung-cad', kind: 'text', steps: ['header'],
  keywords: ['###Panel Added', 'COMP', 'C_PIN', 'NET', 'N_VIA'],
  collect(input, sink) {
    const text = safeText(input.data);
    if (text === null) return;
    sink.variant('samsung-cad'); sink.units('inch', 25.4); sink.padAngle('none');
    let panel = false, pins = false;
    for (const raw of textLines(text)) {
      const line = raw.trim();
      if (line.startsWith('###Panel Added')) { panel = true; sink.section('###Panel Added'); sink.keyword('###Panel Added'); sink.line(raw); continue; }
      const keyword = line.split(/\s+/, 1)[0];
      if (keyword === 'C_PIN') pins = true;
      if (['COMP', 'C_PIN', 'NET', 'N_VIA'].includes(keyword)) { sink.section(keyword); sink.keyword(keyword, words(line).length); }
      else sink.section(NO_SECTION);
      sink.line(raw);
    }
    if (panel && pins) sink.reached('header');
  },
};

// --- KiCad PCB (S-expression) -----------------------------------------------------------------------------------------------------------
const KICAD_TOP = [
  'kicad_pcb', 'version', 'generator', 'generator_version', 'general', 'paper', 'title_block', 'layers', 'setup', 'net', 'net_class', 'footprint', 'module', 'gr_line',
  'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve', 'gr_text', 'gr_text_box', 'dimension', 'segment', 'arc', 'via', 'zone', 'target', 'group', 'image',
  'embedded_fonts', 'embedded_files', 'property', 'generated',
];
const KICAD_NESTED = new Set(['pad', 'fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly', 'fp_curve', 'fp_text', 'fp_text_box', 'model', 'attr']);
const HEAD = /[A-Za-z_][A-Za-z0-9_]*/y;
export const kicadHook: StructureHook = {
  id: 'kicad', kind: 'text', steps: ['header'],
  keywords: [...KICAD_TOP, ...KICAD_NESTED].map(head => `(${head}`),
  collect(input, sink) {
    const text = safeText(input.data);
    if (text === null) return;
    sink.units('mm', 1); sink.padAngle('absolute');
    if (/^\s*(?:;[^\n]*\n\s*)*\(kicad_pcb(?:\s|\))/.test(text)) sink.reached('header');
    sink.section(NO_SECTION);
    let depth = 0, inString = false, versionNext = false, footprints = false, modules = false;
    for (const raw of textLines(text)) {
      for (let index = 0; index < raw.length; index++) {
        const char = raw.charCodeAt(index);
        if (inString) {
          if (char === 92) index++; else if (char === 34) inString = false;
          continue;
        }
        if (char === 34) { inString = true; continue; }
        if (char === 41) { depth = Math.max(0, depth - 1); continue; }
        if (char === 40) {
          depth++;
          HEAD.lastIndex = index + 1;
          const head = HEAD.exec(raw)?.[0];
          if (!head) continue;
          if (depth === 2) {
            sink.keyword(`(${head}`); sink.section(`(${head}`);
            if (head === 'footprint') footprints = true; else if (head === 'module') modules = true;
            versionNext = head === 'version';
            if (versionNext) {
              const value = /^\s+(\d{1,10})\s*\)/.exec(raw.slice(HEAD.lastIndex))?.[1];
              if (value !== undefined && Number(value) <= 0xffffffff) sink.code('version', Number(value));
            }
          } else if (depth === 1 && head === 'kicad_pcb') sink.keyword('(kicad_pcb');
          else if (depth > 2 && KICAD_NESTED.has(head)) sink.keyword(`(${head}`);
        }
      }
      inString = false; // KiCad writes no string across lines; a stray quote must not swallow the rest of the file
      sink.line(raw);
    }
    if (footprints || modules) sink.variant(footprints ? 'kicad-footprint' : 'kicad-module');
  },
};

// --- EAGLE board XML --------------------------------------------------------------------------------------------------------------------
const EAGLE_ELEMENTS = [
  'eagle', 'drawing', 'settings', 'setting', 'grid', 'layers', 'layer', 'board', 'plain', 'libraries', 'library', 'packages', 'package', 'smd', 'pad', 'wire', 'rectangle',
  'circle', 'polygon', 'vertex', 'text', 'hole', 'attributes', 'attribute', 'elements', 'element', 'signals', 'signal', 'contactref', 'via', 'description', 'schematic',
  'designrules', 'param', 'autorouter', 'pass', 'classes', 'class', 'variantdefs', 'variantdef', 'dimension', 'frame', 'compatibility', 'note', 'packages3d', 'package3d',
  'approved',
];
const TAG = /<([A-Za-z][A-Za-z0-9_.:-]*)([^<>]*)/g;
export const eagleHook: StructureHook = {
  id: 'eagle', kind: 'text', steps: ['header'],
  keywords: EAGLE_ELEMENTS.map(name => `<${name}>`),
  collect(input, sink) {
    const text = safeText(input.data);
    if (text === null) return;
    sink.units('mm', 1); sink.padAngle('relative'); // pad angles are package-local plus the element rotation
    sink.section(NO_SECTION);
    let inComment = false, eagle = false, drawing = false, board = false, schematic = false, library = false;
    for (const raw of textLines(text)) {
      let line = raw;
      if (inComment) { const end = line.indexOf('-->'); if (end < 0) { sink.line(raw); continue; } line = line.slice(end + 3); inComment = false; }
      line = line.replace(/<!--.*?-->/g, ' ');
      const open = line.indexOf('<!--');
      if (open >= 0) { line = line.slice(0, open); inComment = true; }
      let first = true;
      for (const match of line.matchAll(TAG)) {
        const name = match[1], word = `<${name}>`;
        if (name === 'eagle') {
          eagle = true;
          const version = /\bversion\s*=\s*"(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?"/.exec(match[2]);
          if (version) sink.code('version', Number(version[1]) * 10000 + Number(version[2]) * 100 + Number(version[3] ?? 0));
        }
        if (name === 'drawing') drawing = true;
        if (name === 'board') board = true;
        if (name === 'schematic') schematic = true;
        if (name === 'library') library = true;
        if (first) { sink.section(word); first = false; }
        sink.keyword(word, (match[2].match(/\s[A-Za-z_:][\w.:-]*\s*=/g) ?? []).length);
      }
      sink.line(raw);
    }
    if (eagle) sink.variant(board ? 'eagle-board' : schematic ? 'eagle-schematic' : library ? 'eagle-library' : 'eagle-board');
    if (eagle && drawing) sink.reached('header');
  },
};

// --- Unrecognized text --------------------------------------------------------------------------------------------------------------------
/** Every keyword of the text hooks: an unrecognized text file is described with the union of their public vocabularies. */
export function genericTextHook(vocabulary: readonly string[]): StructureHook {
  const known = new Set(vocabulary);
  return {
    id: 'generic-text', kind: 'text', steps: [], keywords: vocabulary,
    collect(input: StructureInput, sink: StructureSink) {
      const text = safeText(input.data);
      if (text === null) return;
      sink.section(NO_SECTION);
      for (const raw of textLines(text)) {
        const line = raw.trim();
        sink.line(raw);
        if (!line) continue;
        const first = line.split(/\s+/, 1)[0];
        const candidates = [first, `${first.split('!', 1)[0]}!`, `(${/^\(([A-Za-z_][A-Za-z0-9_]*)/.exec(first)?.[1] ?? ''}`, `<${/^<([A-Za-z][\w.:-]*)/.exec(first)?.[1] ?? ''}>`, line.startsWith('###Panel Added') ? '###Panel Added' : ''];
        const recordKind = /\|RECORD=([A-Za-z]+)\|/.exec(line)?.[1];
        if (recordKind) candidates.push(`RECORD=${recordKind}`);
        const keyword = candidates.find(word => word && known.has(word));
        if (keyword) sink.keyword(keyword, words(line).length); else sink.row(words(line).length);
      }
    },
  };
}
