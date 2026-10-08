/**
 * Everything the fuzzer feeds: every parser of the board registry (called directly, so an unexpected exception is seen as it is and not
 * wrapped by the dispatcher), the board dispatcher, the schematic parsers and dispatcher with the connectivity engine, the shared
 * low-level readers (inflate, s-expressions, XML prolog, text decoding), and from the registry also the sniffs, the containers and the
 * sniff-only identification (targets-registry.ts), and the readers underneath the adapters (targets-lowlevel.ts). The lists are taken
 * from the registries, so a format registered later is fuzzed without touching this file (its seeds come from the fixtures of its
 * adapter folder, seeds.ts).
 */
import { unzlibSync, inflateSync } from 'fflate';
import { xmlRoot } from '../../electron/xml-prolog.mjs';
import { utf8Input } from '../../src/lib/encoding';
import { GenCadParseError } from '../../src/lib/gencad';
import { BoardFormatError, CONTAINER_ADAPTERS, PARSERS, parseBoard } from '../../src/lib/formats';
import { decodeText, TextDecodeError } from '../../src/lib/formats/common';
import { inflateRaw, inflateZlib } from '../../src/lib/formats/compression';
import { loadSchematicDesign, parseSchematic, SCHEMATIC_PARSERS, SchematicError } from '../../src/lib/schematic';
import { readSexpr } from '../../src/lib/schematic/sexpr';
import type { Board } from '../../src/lib/types';
import type { Schematic } from '../../src/lib/schematic/model';
import { MAX_IMPORT_BYTES } from '../../src/lib/formats/common';
import type { FuzzInput } from './corpus';
import { lowLevelReaderTargets } from './targets-lowlevel';
import { readingsTargets } from './targets-readings';
import { registryTargets } from './targets-registry';
import { BOARD_LIMITS, boardUnits, checkBoard, checkConnectivity, checkSchematic, schematicUnits } from './invariants';

export interface FuzzTarget {
  id: string;
  family: 'board' | 'schematic' | 'util';
  /** Corpus adapters whose seeds this target draws from first; the rest of the corpus serves as donors. */
  seeds: readonly string[];
  /** The seeds are turned into this kind of data first (a compressed stream, for the inflaters). */
  prepare?: 'zlib' | 'deflate';
  run(input: FuzzInput): unknown;
  /** The failure types the contract of the function names. Anything else that is thrown is a finding. */
  allowed(error: unknown): boolean;
  /** A violation of what a successful result must satisfy, or null. */
  check?(output: unknown, input: FuzzInput): string | null;
  /** Amount of output of a result, for the bounded-output statistic. */
  units?(output: unknown): number;
  /** The result as text, to compare two runs of the same bytes. */
  digest?(output: unknown): string;
}

// AMBIGUOUS_FORMAT is the dispatcher's answer when several readers claim a file with certainty (adapter registry); it is a documented failure.
const FORMAT_CODES: ReadonlySet<string> = new Set(['INVALID_FORMAT', 'UNRECOGNIZED', 'LIMIT_EXCEEDED', 'KEY_REQUIRED', 'INVALID_KEY', 'COMPANIONS_REQUIRED', 'UNSUPPORTED_VARIANT', 'WRONG_KIND', 'AMBIGUOUS_FORMAT']);
const SCHEMATIC_CODES = new Set(['INVALID_FORMAT', 'UNRECOGNIZED', 'LIMIT_EXCEEDED', 'UNSUPPORTED_VARIANT', 'ABORTED']);

const parseInput = (input: FuzzInput) => ({ name: input.name, data: input.data, ...(input.companions ? { companions: input.companions } : {}), ...(input.options ? { options: input.options } : {}) });
const isBoardError = (error: unknown) => (error instanceof BoardFormatError && FORMAT_CODES.has(error.code)) || error instanceof GenCadParseError;
const boardTargetCheck = (output: unknown) => checkBoard(output as Board);

/** What a dispatcher does with a bug in an adapter: it wraps it. That wrapper is the finding, not an allowed failure. */
export const WRAPPED_FAILURE = /: unexpected parser failure: /;

const boardTargets = (): FuzzTarget[] => [
  ...PARSERS.map((entry): FuzzTarget => ({
    id: `board:${entry.id}`, family: 'board', seeds: [entry.id],
    run: input => entry.parse(parseInput(input)),
    allowed: error => isBoardError(error) || error instanceof TextDecodeError,
    check: boardTargetCheck, units: output => boardUnits(output as Board), digest: output => JSON.stringify(output),
  })),
  {
    id: 'board:dispatch', family: 'board', seeds: [...PARSERS.map(entry => entry.id), ...CONTAINER_ADAPTERS.map(entry => entry.id)],
    run: input => parseBoard(parseInput(input)),
    allowed: error => isBoardError(error) && !WRAPPED_FAILURE.test((error as Error).message),
    check: boardTargetCheck, units: output => boardUnits(output as Board), digest: output => JSON.stringify(output),
  },
];

const isSchematicError = (error: unknown) => error instanceof SchematicError && SCHEMATIC_CODES.has(error.code);
const schematicTargets = (): FuzzTarget[] => [
  ...SCHEMATIC_PARSERS.map((entry): FuzzTarget => ({
    id: `schematic:${entry.id}`, family: 'schematic', seeds: [entry.id],
    run: input => entry.parse(parseInput(input)),
    allowed: isSchematicError,
    check: output => checkSchematic(output as Schematic), units: output => schematicUnits(output as Schematic), digest: output => JSON.stringify(output),
  })),
  {
    id: 'schematic:dispatch', family: 'schematic', seeds: SCHEMATIC_PARSERS.map(entry => entry.id),
    run: input => parseSchematic(parseInput(input)),
    allowed: error => isSchematicError(error) && !WRAPPED_FAILURE.test((error as Error).message),
    check: output => checkSchematic(output as Schematic), units: output => schematicUnits(output as Schematic), digest: output => JSON.stringify(output),
  },
  {
    id: 'schematic:design', family: 'schematic', seeds: SCHEMATIC_PARSERS.map(entry => entry.id),
    run: input => loadSchematicDesign(parseInput(input)),
    allowed: error => isSchematicError(error) && !WRAPPED_FAILURE.test((error as Error).message),
    check: output => { const design = output as ReturnType<typeof loadSchematicDesign>; return checkSchematic(design.schematic) ?? checkConnectivity(design.connectivity, design.schematic); },
    units: output => schematicUnits((output as ReturnType<typeof loadSchematicDesign>).schematic), digest: output => JSON.stringify(output),
  },
];

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(a, b) === 0;
const asText = (input: FuzzInput): string => new TextDecoder('windows-1252').decode(input.data);

const utilTargets = (): FuzzTarget[] => [
  {
    // Our bounded inflater against the reference one: whatever it accepts, the reference accepts and reads the same.
    id: 'util:inflate-zlib', family: 'util', seeds: ['fz', 'kicad', 'bvr'], prepare: 'zlib',
    run: input => inflateZlib(input.data, 4 << 20),
    allowed: error => error instanceof BoardFormatError && FORMAT_CODES.has(error.code),
    check: (output, input) => {
      let reference: Uint8Array;
      try { reference = unzlibSync(input.data); } catch (error) { return `accepted a stream the reference inflater rejects (${(error as Error).message})`; }
      return same(output as Uint8Array, reference) ? null : 'read other bytes than the reference inflater';
    },
    units: output => (output as Uint8Array).length,
  },
  {
    id: 'util:inflate-raw', family: 'util', seeds: ['fz', 'kicad', 'bvr'], prepare: 'deflate',
    run: input => inflateRaw(input.data, 4 << 20),
    allowed: error => error instanceof BoardFormatError && FORMAT_CODES.has(error.code),
    check: (output, input) => {
      const { output: bytes, consumedBytes } = output as ReturnType<typeof inflateRaw>;
      if (!(consumedBytes >= 0 && consumedBytes <= input.data.length)) return `consumed ${consumedBytes} of ${input.data.length} bytes`;
      let reference: Uint8Array;
      try { reference = inflateSync(input.data.subarray(0, consumedBytes)); } catch (error) { return `accepted a stream the reference inflater rejects (${(error as Error).message})`; }
      return same(bytes, reference) ? null : 'read other bytes than the reference inflater';
    },
    units: output => (output as ReturnType<typeof inflateRaw>).output.length,
  },
  {
    id: 'util:sexpr', family: 'util', seeds: ['kicad', 'kicad-sch'],
    run: input => readSexpr(asText(input)),
    allowed: isSchematicError,
    check: output => { const { root, nodes } = output as ReturnType<typeof readSexpr>; return root.kind === 'list' && Number.isSafeInteger(nodes) && nodes >= 0 ? null : 'the root is not a list'; },
    units: output => (output as ReturnType<typeof readSexpr>).nodes,
  },
  {
    id: 'util:xml-root', family: 'util', seeds: ['eagle', 'eagle-sch', 'recognizers'],
    run: input => xmlRoot(asText(input)),
    allowed: () => false,
    check: output => {
      if (output === null) return null;
      const value = output as { root?: unknown; unsafe?: unknown };
      return (typeof value.root === 'string' && value.unsafe === undefined) || (value.unsafe === true && value.root === undefined) ? null : 'the result is neither null, a root nor unsafe';
    },
  },
  {
    id: 'util:decode-text', family: 'util', seeds: ['gencad', 'bvr', 'brd'],
    run: input => decodeText(input.data),
    allowed: error => error instanceof TextDecodeError || (error instanceof BoardFormatError && error.code === 'LIMIT_EXCEEDED'),
    check: output => (typeof output === 'string' ? null : 'the result is not text'),
  },
  {
    id: 'util:utf8-input', family: 'util', seeds: ['gencad', 'bvr', 'asc'],
    run: input => utf8Input({ data: input.data, ...(input.companions ? { companions: input.companions } : {}) }),
    allowed: () => false,
    check: (output, input) => {
      const result = output as { data: Uint8Array };
      return result.data instanceof Uint8Array && result.data.length <= input.data.length * 3 + 8 ? null : 'the result is not bytes, or is far larger than the input';
    },
  },
];

export const ALL_TARGETS = (): FuzzTarget[] => [
  ...boardTargets(), ...schematicTargets(), ...registryTargets(), ...utilTargets(), ...lowLevelReaderTargets(), ...readingsTargets(),
];

/** Limits the targets run under, for the report. */
export const IMPORT_LIMIT = MAX_IMPORT_BYTES;
export { BOARD_LIMITS };
