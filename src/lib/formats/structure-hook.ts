/*
 * The optional structure hook of a board adapter (original TRACE module, MIT; docs/ADAPTERS.md, "Diagnostic structure hook").
 *
 * The content-free format diagnostic report (docs/DIAGNOSTIC-REPORT.md) describes the layout of a file that fails or opens wrongly
 * without copying anything of it. An adapter that wants its format described carries a `structure` member next to `sniff` and
 * `parse`; an adapter without one is reported with its detection and result facts only.
 *
 * A hook never returns text. It talks to a StructureSink, and the sink accepts only what the report schema
 * (electron/diagnostic-schema.json) whitelists: keywords the hook declared AND the schema lists, header fields from closed lists
 * with integer values, numeric tokens as order of magnitude and decimal places, and at level 2 collapsed line shapes or the tag and
 * length of binary blocks. A hook author therefore cannot put a reference, a net name, a coordinate or any other string of the file
 * into a report without changing the schema, which the golden test (src/lib/diagnostics/schema.golden.txt) guards.
 */
import type { HeaderCode, HeaderCount, HookId, PadAngleMode, Stage, UnitKind, Variant } from '../diagnostics/report';

/** The pipeline steps a hook can confirm; 'records' and 'build' follow once every step of the format is complete. */
export type HookStep = Extract<Stage, 'header' | 'container' | 'decrypt' | 'decompress'>;

export interface StructureInput {
  /** The primary file, normalized like the dispatcher does (BOM-marked UTF-16 re-encoded as UTF-8). */
  readonly data: Uint8Array;
  /** Companion files by lowercase basename (the ASC trio); the only other files a hook may look at. */
  readonly companions: Readonly<Record<string, Uint8Array>>;
  /** The lowercase extension class of the file (see input-facts.ts): selects the FZ/CAE parity variant, nothing else. */
  readonly extension: string;
  /** The fixed public basename of a companion-set member (format.asc, pins.asc, nails.asc), when the file is one; never any other name. */
  readonly companionRole?: string;
  /** Session keys the user typed for this run; a hook may use them to reach the structure behind the encryption, never report them. */
  readonly keys: { readonly fzKey?: readonly number[]; readonly xzzKey?: string };
}

export interface StructureSink {
  readonly level: 1 | 2;
  variant(value: Variant): void;
  /** One pipeline step of the format completed (see HookStep). */
  reached(step: HookStep): void;
  /** The unit the reader applies; `toMm` (source unit to millimetres) only feeds the plausibility frame and is never reported. */
  units(kind: UnitKind, toMm?: number): void;
  /** How the reader composes pad angles: board-absolute, relative to the component, or the format has none. */
  padAngle(mode: PadAngleMode): void;
  /** A whitelisted header field with a small code value (a version, a unit code, a flag). */
  code(field: HeaderCode, value: number): void;
  /** A whitelisted header field with a count; it is rounded to two significant digits. */
  count(field: HeaderCount, value: number): void;
  /** One record of a whitelisted keyword with its number of fields; an unlisted keyword is dropped (counted nowhere). */
  keyword(word: string, fields?: number): void;
  /** One data row of the current section (formats whose rows carry no keyword): its field count is filed under the section name. */
  row(fields: number): void;
  /** Starts a section named by a whitelisted keyword (NO_SECTION for lines outside any section). */
  section(word: string): void;
  /** One physical line: counted, its numeric tokens feed the number statistics, and at level 2 the first 32 lines of each section give shapes. */
  line(text: string, separators?: RegExp): void;
  /** One binary block (tag, byte length): a tag histogram, power-of-two length buckets and, at level 2, the first 256 pairs. */
  block(tag: number, length: number, tagBits: number): void;
}

export interface StructureHook {
  /** The hook family (several adapters may share one: BRD and BRD2, BVR 1 and 3). */
  readonly id: HookId;
  readonly kind: 'text' | 'binary';
  /** Public keywords of the format this hook may count; each one must be in the schema's keyword enumeration (tested). */
  readonly keywords: readonly string[];
  /** The pipeline of the format, in order: the steps `reached` may confirm; the stage of a failure is the first step the hook could not complete. */
  readonly steps: readonly HookStep[];
  /** Bounded, linear in the input and total: it never throws (the collector still catches and reports headerOk false). */
  collect(input: StructureInput, sink: StructureSink): void;
}
