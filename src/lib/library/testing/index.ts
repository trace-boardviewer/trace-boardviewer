/*
 * The synthetic library for tests and benchmarks of the Library. Tests and scripts only: the application never imports this folder.
 *
 *   generateMemoryLibrary(options)   a whole library (files by path) with its ground truth, in memory
 *   generateLibrary(options, sink)   the same into a sink (scripts/gen-synthetic-library.cjs writes to disk through it)
 *   sampleFamily(options)            one board family: revisions, formats and schematics, for module tests
 *   scoreResult / checkTargets       the metrics runner (metrics.ts); contract.ts converts the Library's own records into its input
 *   checkTruth / checkFiles          consistency checks of a ground truth and of the files it describes
 *   readBoard / readPdfText          the application's own readers, for tests that read generated files back (read-back.ts, not exported here)
 */
export { generateLibrary, generateMemoryLibrary } from './library.ts';
export type { GeneratedLibrary, LibraryStats, MemoryLibrary } from './library.ts';
export type { LibrarySink } from './engine.ts';
export { PRESETS, PRESET_NAMES, parseByteSize, resolveOptions } from './presets.ts';
export type { LibraryOptions, PresetName } from './presets.ts';
export { GENERATOR_VERSION, GROUND_TRUTH_SCHEMA, GROUND_TRUTH_SCHEMA_VERSION } from './ground-truth.ts';
export type { GroundTruth, TruthFamily, TruthGroup, TruthItem } from './ground-truth.ts';
export { checkFiles, checkTruth } from './check-truth.ts';
export { RESULT_SCHEMA, RESULT_VERSION, TARGETS, checkTargets, oracleResult, regressions, scoreResult, validateResult } from './metrics.ts';
export type { LibraryMetrics, LibraryResult, ResultGroup, ResultMember, TargetCheck } from './metrics.ts';
export { sampleFamily } from './samples.ts';
export type { SampleBoardFile, SampleFamily, SampleOptions, SampleRevision } from './samples.ts';
export { registerBoardWriter, boardWriters } from './board-writers.ts';
export type { BoardWriter } from './board-writers.ts';
