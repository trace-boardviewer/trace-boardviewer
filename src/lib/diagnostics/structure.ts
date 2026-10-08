/*
 * Structure hooks of the diagnostic report (original TRACE module, MIT).
 *
 * A hook describes the layout of one format without reporting its content. It never returns text: it talks to a StructureSink,
 * and the sink accepts only what the whitelist allows. Keywords count only when the hook declared them AND the schema lists them
 * (electron/diagnostic-schema.json, enums.keyword); header fields are closed enumerations with integer values; numeric tokens
 * become order-of-magnitude and decimal-place counts; a line becomes, at level 2 only, a collapsed shape in which every letter run
 * is "A", every digit run "9" and only ASCII punctuation survives. A hook author therefore cannot put a reference, a net name, a
 * coordinate or any other string of the file into a report without changing the schema, which the golden test guards.
 *
 * The hook interface lives in src/lib/formats/structure-hook.ts: a board adapter carries it as its optional `structure` member.
 */
import { decodeText } from '../formats/common';
import type { FormatErrorCode } from '../formats/common';
import type { HookStep, StructureHook, StructureSink } from '../formats/structure-hook';
import {
  bitLength, count2, HEADER_CODES, HEADER_COUNTS, KEYWORDS, log2Ceil, NO_SECTION,
  type BlockFacts, type FieldStats, type HeaderCode, type HeaderCount, type PadAngleMode, type SectionFacts, type Stage, type StructureFacts, type UnitKind, type Variant,
} from './report';

export type { HookStep, StructureHook, StructureInput, StructureSink } from '../formats/structure-hook';

// --- Shapes and numbers -----------------------------------------------------------------------------------------------------------
const SHAPE_LINES = 32, MAX_SHAPE = 120, MAX_SECTIONS = 64, MAX_SEQUENCE = 256, MAX_SHAPES_PER_SECTION = 32;
const LETTER_RUN = /\p{L}[\p{L}\p{M}]*/gu, DIGIT_RUN = /\p{N}+/gu, SPACE_RUN = /\s+/gu;
/** Keeps 'A', '9', blank and printable ASCII punctuation; every other character (controls, symbols, private use) becomes '?'. */
const NOT_SHAPE = /[^A9 !-/:-@[-`{-~]/g;
/** The level-2 shape of one line: letter runs become A, digit runs 9, blank runs one blank, ASCII punctuation stays. */
export function collapseShape(line: string): string {
  const shape = line.trim().replace(LETTER_RUN, 'A').replace(DIGIT_RUN, '9').replace(SPACE_RUN, ' ').replace(NOT_SHAPE, '?');
  return shape.slice(0, MAX_SHAPE);
}

const DECIMAL = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;
const DEFAULT_SEPARATORS = /[\s,;|!()<>="'[\]{}]+/;
/** Order of magnitude (floor(log10 |x|), clamped to -15..15, "zero" for 0) and decimal places (0..9, "10+") of one numeric token. */
export function numberClass(token: string): { magnitude: string; decimals: string } | null {
  if (!DECIMAL.test(token)) return null;
  const value = Number(token.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const mantissa = token.replace(/[eE].*$/, ''), point = mantissa.search(/[.,]/);
  const places = point < 0 ? 0 : mantissa.length - point - 1;
  const magnitude = value === 0 ? 'zero' : String(Math.max(-15, Math.min(15, Math.floor(Math.log10(Math.abs(value)) + 1e-12))));
  return { magnitude, decimals: places >= 10 ? '10+' : String(places) };
}

/** Field counts of one record type: exact minimum and maximum; the median of the first 100,000 records (bounded memory). */
class Stats {
  private readonly values: number[] = [];
  private min = Infinity;
  private max = -Infinity;
  add(value: number) {
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    if (this.values.length < 100_000) this.values.push(value);
  }
  result(): FieldStats {
    const sorted = [...this.values].sort((a, b) => a - b), middle = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { min: Math.min(1_000_000, this.min), median: Math.min(1_000_000, Number(median.toFixed(1))), max: Math.min(1_000_000, this.max) };
  }
}

interface SectionState { name: string; records: number; shapes: Map<string, number>; shapeLines: number; distinct: Set<string>; distinctOverflow: boolean }

const HEADER_CODE_SET: ReadonlySet<string> = new Set(HEADER_CODES), HEADER_COUNT_SET: ReadonlySet<string> = new Set(HEADER_COUNTS);
const MAX_DISTINCT = 100_000;

/** The sink of one hook run: everything the hook reports is checked against the hook's own lists and the schema's. */
export class FactSink implements StructureSink {
  readonly level: 1 | 2;
  private readonly allowed: ReadonlySet<string>;
  private variantValue: Variant | null = null;
  private readonly steps = new Set<HookStep>();
  unitKind: UnitKind = 'unknown';
  toMm: number | null = null;
  padAngleMode: PadAngleMode | 'unknown' = 'unknown';
  private readonly codes: Partial<Record<HeaderCode, number>> = {};
  private readonly counts: Partial<Record<HeaderCount, number>> = {};
  private readonly keywordCounts = new Map<string, number>();
  private readonly fieldStats = new Map<string, Stats>();
  private lines = 0;
  private numbers = 0;
  private readonly magnitudes = new Map<string, number>();
  private readonly decimals = new Map<string, number>();
  private readonly sections: SectionState[] = [];
  private current: SectionState | null = null;
  /** Names of sections that are not whitelisted: kept only to count the distinct ones, never reported. */
  private readonly otherSections = new Set<string>();
  private otherSection(word: string) { if (this.otherSections.size < MAX_DISTINCT) this.otherSections.add(word); }
  private blockFacts: { tagBits: number; tags: Map<number, number>; lengths: Map<number, number>; sequence: Array<[number, number]> } | null = null;

  private blockCount = 0;
  /** `tick` is called now and then during a long scan (every 32768 lines, every 16384 blocks): a sign of life for the watchdog of the dialog. */
  constructor(private readonly hook: StructureHook, level: 1 | 2, private readonly tick?: () => void) {
    this.level = level;
    this.allowed = new Set(hook.keywords.filter(word => KEYWORDS.has(word)));
  }
  variant(value: Variant) { this.variantValue = value; }
  reached(step: HookStep) { if (this.hook.steps.includes(step)) this.steps.add(step); }
  has(step: HookStep): boolean { return this.steps.has(step); }
  get sawLines(): boolean { return this.lines > 0; }
  units(kind: UnitKind, toMm?: number) { this.unitKind = kind; this.toMm = toMm !== undefined && Number.isFinite(toMm) && toMm > 0 ? toMm : null; }
  padAngle(mode: PadAngleMode) { this.padAngleMode = mode; }
  code(field: HeaderCode, value: number) {
    if (HEADER_CODE_SET.has(field) && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) this.codes[field] = value;
  }
  count(field: HeaderCount, value: number) {
    if (HEADER_COUNT_SET.has(field) && Number.isFinite(value) && value >= 0) this.counts[field] = Math.min(100_000_000, count2(value));
  }
  keyword(word: string, fields?: number) {
    if (!this.allowed.has(word)) return;
    this.keywordCounts.set(word, (this.keywordCounts.get(word) ?? 0) + 1);
    if (fields !== undefined && Number.isSafeInteger(fields) && fields >= 0) {
      let stats = this.fieldStats.get(word);
      if (!stats) { stats = new Stats(); this.fieldStats.set(word, stats); }
      stats.add(fields);
    }
    if (this.current) this.current.records++;
  }
  row(fields: number) {
    const name = this.current?.name ?? NO_SECTION;
    if (this.current) this.current.records++;
    if (!Number.isSafeInteger(fields) || fields < 0) return;
    let stats = this.fieldStats.get(name);
    if (!stats) {
      if (this.fieldStats.size >= 400) return;
      stats = new Stats(); this.fieldStats.set(name, stats);
    }
    stats.add(fields);
  }
  section(word: string) {
    const name = word === NO_SECTION || this.allowed.has(word) ? word : null;
    if (name === null) { this.current = null; this.otherSection(word); return; }
    const existing = this.sections.find(section => section.name === name);
    if (existing) { this.current = existing; return; }
    if (this.sections.length >= MAX_SECTIONS) { this.current = null; this.otherSection(word); return; }
    this.current = { name, records: 0, shapes: new Map(), shapeLines: 0, distinct: new Set(), distinctOverflow: false };
    this.sections.push(this.current);
  }
  line(text: string, separators: RegExp = DEFAULT_SEPARATORS) {
    if ((++this.lines & 0x7fff) === 0) this.tick?.();
    for (const token of text.split(separators)) {
      if (!token) continue;
      const kind = numberClass(token);
      if (!kind) continue;
      this.numbers++;
      this.magnitudes.set(kind.magnitude, (this.magnitudes.get(kind.magnitude) ?? 0) + 1);
      this.decimals.set(kind.decimals, (this.decimals.get(kind.decimals) ?? 0) + 1);
    }
    if (this.level !== 2 || !this.current || !text.trim()) return;
    const section = this.current, shape = collapseShape(text);
    if (!shape) return;
    if (section.shapeLines < SHAPE_LINES) {
      section.shapeLines++;
      if (section.shapes.has(shape) || section.shapes.size < MAX_SHAPES_PER_SECTION) section.shapes.set(shape, (section.shapes.get(shape) ?? 0) + 1);
    }
    if (section.distinct.size < MAX_DISTINCT) section.distinct.add(shape); else section.distinctOverflow = true;
  }
  block(tag: number, length: number, tagBits: number) {
    if ((++this.blockCount & 0x3fff) === 0) this.tick?.();
    if (!Number.isSafeInteger(tag) || tag < 0 || tag > 0xffff || !Number.isSafeInteger(length) || length < 0) return;
    this.blockFacts ??= { tagBits: Math.max(1, Math.min(32, tagBits)), tags: new Map(), lengths: new Map(), sequence: [] };
    const facts = this.blockFacts;
    if (facts.tags.has(tag) || facts.tags.size < 256) facts.tags.set(tag, (facts.tags.get(tag) ?? 0) + 1);
    const bucket = bitLength(Math.min(length, 0xffffffff));
    facts.lengths.set(bucket, (facts.lengths.get(bucket) ?? 0) + 1);
    if (this.level === 2 && facts.sequence.length < MAX_SEQUENCE) facts.sequence.push([tag, Math.min(length, 0xffffffff)]);
  }

  /** The facts, rounded and in whitelist form. `steps` decides headerOk: the header step was confirmed. */
  facts(kind: 'text' | 'binary', textLines: boolean): StructureFacts {
    const sorted = <V, R>(map: Map<string, V>, value: (item: V) => R): Record<string, R> => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, value(item)]));
    const sections: SectionFacts[] = this.sections.map(section => ({
      name: section.name, records: count2(section.records),
      ...(this.level === 2 ? {
        distinctShapes: count2(section.distinct.size),
        shapes: [...section.shapes].map(([shape, count]) => ({ shape, count })),
      } : {}),
    }));
    if (this.otherSections.size) this.counts.otherSections = Math.min(100_000_000, count2(this.otherSections.size));
    const blocks: BlockFacts | null = this.blockFacts ? {
      tagBits: this.blockFacts.tagBits,
      tags: Object.fromEntries([...this.blockFacts.tags].sort(([a], [b]) => a - b).map(([tag, count]) => [String(tag), count2(count)])),
      lengths: Object.fromEntries([...this.blockFacts.lengths].sort(([a], [b]) => a - b).map(([bucket, count]) => [String(bucket), count2(count)])),
      ...(this.level === 2 ? { sequence: this.blockFacts.sequence.map(([tag, length]) => [tag, length] as [number, number]) } : {}),
    } : null;
    return {
      hook: this.hook.id, kind, variant: this.variantValue, headerOk: this.steps.has('header'),
      linesLog2: textLines ? Math.min(27, log2Ceil(this.lines)) : null,
      keywords: sorted(this.keywordCounts, count => Math.min(100_000_000, count2(count))),
      fields: sorted(this.fieldStats, stats => stats.result()),
      numbers: textLines ? { count: Math.min(100_000_000, count2(this.numbers)), magnitude: sorted(this.magnitudes, count2), decimals: sorted(this.decimals, count2) } : null,
      sections, header: { codes: { ...this.codes }, counts: { ...this.counts } }, blocks,
    };
  }
}

/** The stage of a failure as far as the hook can tell: the first step of the format's pipeline it could not complete, else records. */
export function stageFromHook(hook: StructureHook, sink: FactSink): Stage {
  for (const step of hook.steps) if (!sink.has(step)) return step;
  return 'records';
}

/** Splits decoded text into lines (CR LF, CR or LF) without building the whole array for a 64 MiB file. */
export function* textLines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    yield text.slice(start, index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    start = index + 1;
  }
  if (start < text.length) yield text.slice(start);
}

/** decodeText that never throws: a hook that cannot decode reports what it saw so far. */
export function safeText(data: Uint8Array): string | null {
  try { return decodeText(data); } catch { return null; }
}

/** The format error codes that decide the stage on their own, whatever the hook saw. */
export function stageOfCode(code: FormatErrorCode | 'INTERNAL' | 'AMBIGUOUS_FORMAT'): Stage | null {
  if (code === 'KEY_REQUIRED' || code === 'INVALID_KEY') return 'decrypt';
  if (code === 'COMPANIONS_REQUIRED') return 'container';
  return null;
}
