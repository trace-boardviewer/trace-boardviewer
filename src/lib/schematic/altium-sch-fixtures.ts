/*
 * Original synthetic SchDoc builders for the tests of the Altium schematic reader (no vendor or third-party data): small documents are
 * written record by record and wrapped in a real OLE compound file (the `cfb` package is only the WRITER here; the reader under test
 * is the bounded one in formats/altium-cfb.ts) or in the line-based "Ascii File" form.
 *
 * Geometry is in sheet units (10 mil, Y up) exactly as a SchDoc stores it. On the default A4 sheet (1150 x 760 units) a point (ux, uy)
 * lands at ((ux * 0.254) mm, ((760 - uy) * 0.254) mm) in the model.
 */
import CFB from 'cfb';
import { expect } from 'vitest';
import { parseAltiumSch } from './altium-sch';
import { computeConnectivity } from './connectivity';
import { SchematicError, type SchConnectivity, type SchNet, type Schematic, type SchematicErrorCode, type SchSheetDef, type SchSymbol } from './model';

export type Val = string | number | boolean;
export type Rec = Record<string, Val>;

export const enc = new TextEncoder();
const u32 = (value: number): number[] => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
export function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const val = (value: Val): string => value === true ? 'T' : value === false ? 'F' : String(value);
export const recordText = (record: Rec): string => `|${Object.entries(record).map(([key, value]) => `${key}=${val(value)}`).join('|')}|`;
/** One length-prefixed record: [u32 length | flag << 24][text + NUL]. A non-zero flag marks a binary record. */
export const framed = (text: string, flag = 0): Uint8Array => { const body = enc.encode(`${text}\0`); return concat(u32((flag << 24 | body.length) >>> 0), body); };

export const HEADER = '|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0|Weight=0';
export const ASCII_HEADER = '|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=0';
export const LIBRARY_HEADER = '|HEADER=Protel for Windows - Schematic Library Editor Binary File Version 5.0|Weight=0';

export interface PinSpec {
  n: string; name?: string; x: number; y: number;
  /** Pin direction (PinConglomerate bits 0-1): 0 right, 1 up, 2 left, 3 down; the connection point is `len` units away from (x, y). */
  dir?: 0 | 1 | 2 | 3; len?: number; elec?: number; hidden?: boolean; hiddenNet?: string; part?: number; mode?: number;
}

export interface PartOptions {
  ref: string; x: number; y: number; pins: PinSpec[];
  lib?: string; params?: Record<string, string>; hiddenParams?: Record<string, string>; partId?: number; partCount?: number; mode?: number;
  orientation?: number; mirrored?: boolean; footprints?: Array<{ name: string; current?: boolean; type?: string }>; extra?: Rec; designator?: Rec;
}

export interface PortOptions { name: string; x: number; y: number; width?: number; io?: number; style?: number; hidden?: boolean }
export interface SheetSymbolOptions { name: string; file: string; x: number; y: number; w: number; h: number; entries?: Array<{ name: string; side?: number; dist: number; io?: number }> }

type Item = { rec: Rec } | { raw: Uint8Array };

/** One schematic document: records are added in file order; `OwnerIndex` values are positions among the records after the header. */
export class Sheet {
  readonly items: Item[] = [];
  header = HEADER;
  constructor(sheetRecord: Rec | null = {}) { if (sheetRecord) this.add(31, { FontIdCount: 1, Size1: 10, FontName1: 'Times New Roman', ...sheetRecord }); }

  get count(): number { return this.items.length; }
  add(record: number, rec: Rec = {}, owner?: number): number {
    this.items.push({ rec: { RECORD: record, ...(owner === undefined ? {} : { OwnerIndex: owner }), ...rec } });
    return this.items.length - 1;
  }
  /** A binary-flagged record (it occupies an index like any other). */
  binary(bytes: number[] = [1, 2, 3, 4]): number { this.items.push({ raw: framed(String.fromCharCode(...bytes), 1) }); return this.items.length - 1; }

  part(o: PartOptions): number {
    const parts = o.partCount ?? 1;
    const index = this.add(1, {
      LibReference: o.lib ?? 'RES', ComponentDescription: 'Synthetic part', PartCount: parts + 1, DisplayModeCount: 1, ...(o.mode ? { DisplayMode: o.mode } : {}),
      OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y, CurrentPartId: o.partId ?? 1, SourceLibraryName: 'Synthetic.IntLib', ...(o.orientation ? { Orientation: o.orientation } : {}),
      ...(o.mirrored ? { IsMirrored: true } : {}), ...o.extra,
    });
    for (const pin of o.pins) {
      this.add(2, {
        OwnerPartId: pin.part ?? -1, ...(pin.mode ? { OwnerPartDisplayMode: pin.mode } : {}), FormalType: 1, Electrical: pin.elec ?? 4,
        PinConglomerate: 32 | (pin.dir ?? 0) | (pin.hidden ? 4 : 0), PinLength: pin.len ?? 10, 'Location.X': pin.x, 'Location.Y': pin.y, Name: pin.name ?? pin.n, Designator: pin.n,
        ...(pin.hiddenNet ? { HiddenNetName: pin.hiddenNet } : {}),
      }, index);
    }
    this.add(34, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y + 5, Color: 8388608, FontID: 1, Text: o.ref, Name: 'Designator', ReadOnlyState: 1, ...o.designator }, index);
    for (const [name, text] of Object.entries(o.params ?? {})) this.add(41, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y - 5, FontID: 1, Text: text, Name: name }, index);
    for (const [name, text] of Object.entries(o.hiddenParams ?? {})) this.add(41, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y - 5, FontID: 1, IsHidden: true, Text: text, Name: name }, index);
    if (o.footprints) {
      const list = this.add(44, { OwnerPartId: -1 }, index);
      for (const fp of o.footprints) this.add(45, { ModelName: fp.name, ModelType: fp.type ?? 'PCBLIB', IsCurrent: fp.current ?? false, Description: 'footprint' }, list);
    }
    return index;
  }
  /** Two-pin part with pin 1 at (cx - 20, cy) and pin 2 at (cx + 20, cy). */
  res(ref: string, cx: number, cy: number, o: Partial<PartOptions> = {}): number {
    return this.part({
      ref, x: cx, y: cy, lib: 'RES', params: { Comment: '10k' }, ...o,
      pins: o.pins ?? [{ n: '1', x: cx - 10, y: cy, dir: 2 }, { n: '2', x: cx + 10, y: cy, dir: 0 }],
    });
  }
  wire(...points: Array<[number, number]>): number {
    const rec: Rec = { OwnerPartId: -1, LineWidth: 1, LocationCount: points.length };
    points.forEach(([x, y], k) => { rec[`X${k + 1}`] = x; rec[`Y${k + 1}`] = y; });
    return this.add(27, rec);
  }
  bus(...points: Array<[number, number]>): number {
    const rec: Rec = { OwnerPartId: -1, LineWidth: 1, LocationCount: points.length };
    points.forEach(([x, y], k) => { rec[`X${k + 1}`] = x; rec[`Y${k + 1}`] = y; });
    return this.add(26, rec);
  }
  junction(x: number, y: number): number { return this.add(29, { OwnerPartId: -1, 'Location.X': x, 'Location.Y': y }); }
  label(text: string, x: number, y: number, orientation = 0): number { return this.add(25, { OwnerPartId: -1, 'Location.X': x, 'Location.Y': y, ...(orientation ? { Orientation: orientation } : {}), Text: text }); }
  power(text: string, x: number, y: number, o: { style?: number; orientation?: number; showName?: boolean; offSheet?: boolean } = {}): number {
    return this.add(17, {
      OwnerPartId: -1, ...(o.orientation ? { Orientation: o.orientation } : {}), Style: o.style ?? 1, 'Location.X': x, 'Location.Y': y, ShowNetName: o.showName ?? true, Text: text,
      ...(o.offSheet ? { IsCrossSheetConnector: true } : {}),
    });
  }
  port(o: PortOptions): number {
    return this.add(18, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y, Style: o.style ?? 3, ...(o.io ? { IOType: o.io } : {}), Alignment: 2, Width: o.width ?? 60, Height: 10, Name: o.name });
  }
  noErc(x: number, y: number, active = true): number { return this.add(22, { OwnerPartId: -1, 'Location.X': x, 'Location.Y': y, Symbol: 'Thick Cross', IsActive: active }); }
  sheetSymbol(o: SheetSymbolOptions): number {
    const index = this.add(15, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y, XSize: o.w, YSize: o.h });
    this.add(32, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y + 5, Text: o.name }, index);
    this.add(33, { OwnerPartId: -1, 'Location.X': o.x, 'Location.Y': o.y - o.h - 5, Text: o.file }, index);
    for (const e of o.entries ?? []) this.add(16, { OwnerPartId: -1, Side: e.side ?? 0, DistanceFromTop: e.dist, IOType: e.io ?? 3, Name: e.name }, index);
    return index;
  }
  rect(x1: number, y1: number, x2: number, y2: number, owner?: number, solid = false): number { return this.add(14, { 'Location.X': x1, 'Location.Y': y1, 'Corner.X': x2, 'Corner.Y': y2, IsSolid: solid, ...(owner === undefined ? {} : { OwnerPartId: 1 }) }, owner); }
  line(x1: number, y1: number, x2: number, y2: number, owner?: number): number { return this.add(13, { 'Location.X': x1, 'Location.Y': y1, 'Corner.X': x2, 'Corner.Y': y2 }, owner); }
  text(text: string, x: number, y: number, owner?: number): number { return this.add(4, { 'Location.X': x, 'Location.Y': y, FontID: 1, Text: text }, owner); }
  /** Sheet-level parameter (title block fields). */
  param(name: string, text: string): number { return this.add(41, { 'Location.X': 0, 'Location.Y': 0, Text: text, Name: name, IsHidden: true }); }

  /** The FileHeader stream. */
  stream(): Uint8Array { return concat(framed(this.header), ...this.items.map(item => 'raw' in item ? item.raw : framed(recordText(item.rec)))); }
  /** A SchDoc: an OLE compound file with FileHeader (and the Additional stream real files carry, which the reader ignores). */
  file(extra: Record<string, Uint8Array> = {}): Uint8Array { return container({ FileHeader: this.stream(), Additional: framed('|HEADER=Additional'), ...extra }); }
  /** The line-based export of the same records. */
  ascii(newline = '\r\n', tail = ''): Uint8Array {
    const header = this.header.replace('Binary', 'Ascii');
    return enc.encode(`${header}${newline}${this.items.map(item => 'rec' in item ? recordText(item.rec) : '|RECORD=0|').join(newline)}${newline}${tail}`);
  }
}

export function container(streams: Record<string, Uint8Array>): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  for (const [path, content] of Object.entries(streams)) CFB.utils.cfb_add(cfb, `/${path}`, content);
  return Uint8Array.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
}

/** A .PrjPcb project file. */
export function project(documents: string[], hierarchyMode?: number, extra = ''): Uint8Array {
  const lines = ['[Design]', 'Version=1.0', ...(hierarchyMode === undefined ? [] : [`HierarchyMode=${hierarchyMode}`]), 'AllowPortNetNames=0', ''];
  documents.forEach((path, k) => lines.push(`[Document${k + 1}]`, `DocumentPath=${path}`, 'AnnotationEnabled=1', ''));
  return enc.encode(lines.join('\r\n') + extra);
}

/** Deterministic pseudo-random numbers (mulberry32) for the mutation tests. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6d2b79f5 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers shared by the test files
// ---------------------------------------------------------------------------------------------------------------

export const MM = 0.254;
export const mmX = (units: number): number => units * MM;
/** Y of a point on the default A4 sheet (760 units high), model Y down. */
export const mmY = (units: number, height = 760): number => (height - units) * MM;
export const close = (actual: number, expected: number, digits = 6): void => expect(actual).toBeCloseTo(expected, digits);

export const input = (data: Uint8Array, name = 'Test.SchDoc', companions?: Record<string, Uint8Array>) => ({ name, data, ...(companions ? { companions } : {}) });
export const parse = (data: Uint8Array, name = 'Test.SchDoc', companions?: Record<string, Uint8Array>): Schematic | null => parseAltiumSch(input(data, name, companions));
export const must = (data: Uint8Array, name?: string, companions?: Record<string, Uint8Array>): Schematic => {
  const result = parse(data, name, companions);
  if (!result) throw new Error('expected a schematic');
  return result;
};
export const lower = (files: Record<string, Uint8Array>): Record<string, Uint8Array> => Object.fromEntries(Object.entries(files).map(([name, data]) => [name.toLowerCase(), data]));
export const codes = (s: Schematic): string[] => s.diagnostics.map(d => d.code);
export const thrown = (action: () => unknown, code?: SchematicErrorCode): SchematicError => {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(SchematicError);
    if (code) expect((error as SchematicError).code).toBe(code);
    return error as SchematicError;
  }
  throw new Error('expected a SchematicError');
};
export const def = (s: Schematic, index = 0): SchSheetDef => s.defs[index];
export const symbolOf = (d: SchSheetDef, ref: string, unit?: number): SchSymbol => {
  const found = d.symbols.find(symbol => symbol.refDefault === ref && (unit === undefined || symbol.unit === unit));
  if (!found) throw new Error(`no symbol ${ref}`);
  return found;
};
export const pinOf = (symbol: SchSymbol, number: string) => {
  const found = symbol.pins.find(pin => pin.number === number);
  if (!found) throw new Error(`no pin ${number} on ${symbol.refDefault}`);
  return found;
};
/** "R1.2" -> its net, by annotated reference and pin number (the board's identity). */
export const netOf = (c: SchConnectivity, pin: string): SchNet | undefined => {
  const dot = pin.lastIndexOf('.');
  return c.nets.find(net => net.members.some(m => m.ref === pin.slice(0, dot) && m.pinNumber === pin.slice(dot + 1)));
};
export const netName = (c: SchConnectivity, pin: string): string | undefined => netOf(c, pin)?.name;
export const sameNet = (c: SchConnectivity, a: string, b: string): boolean => { const x = netOf(c, a); return x !== undefined && x === netOf(c, b); };
export const pinsOf = (net: SchNet | undefined): string[] => (net?.members ?? []).map(m => `${m.ref}.${m.pinNumber}`).sort();
export const connect = (s: Schematic): SchConnectivity => computeConnectivity(s);

/**
 * The reference design: R1 -- MID -- R2 between a VCC power port and a GND power port (A4 sheet).
 *   R1 pin 1 (180,500) pin 2 (220,500); R2 pin 1 (280,500) pin 2 (320,500); wire (220,500)-(280,500) carries the net label MID.
 */
export function divider(): Sheet {
  const s = new Sheet({ SheetStyle: 0 });
  s.res('R1', 200, 500);
  s.res('R2', 300, 500, { params: { Comment: '4k7' } });
  s.wire([220, 500], [280, 500]);
  s.label('MID', 250, 500);
  s.wire([180, 500], [180, 540]);
  s.power('VCC', 180, 540, { style: 1, orientation: 1 });
  s.wire([320, 500], [320, 460]);
  s.power('GND', 320, 460, { style: 4, orientation: 3 });
  return s;
}
