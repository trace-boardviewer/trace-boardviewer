/*
 * What the user chose to share (original TRACE module, MIT): the collector always builds the fullest report (level 2, with the dedupe code it was
 * given); this keeps what the review dialog shows and the save path writes. Kept apart from the collector so that the dialog does not load it.
 */
import type { DiagnosticReport, StructureFacts } from './report';

export interface ProjectOptions { level: 1 | 2; dedupe: boolean; reviewed: boolean }

/** The report the user chose to share: level 1 drops every level-2 field; without consent the dedupe code is removed. */
export function projectReport(full: DiagnosticReport, options: ProjectOptions): DiagnosticReport {
  const level2 = options.level === 2;
  let structure: StructureFacts | null = null;
  if (full.structure) {
    const { blocks, sections } = full.structure;
    let projectedBlocks: StructureFacts['blocks'] = null;
    if (blocks) {
      const { sequence, ...rest } = blocks;
      projectedBlocks = level2 && sequence ? { ...rest, sequence } : rest;
    }
    structure = {
      ...full.structure,
      sections: sections.map(({ name, records, distinctShapes, shapes }) => ({ name, records, ...(level2 && distinctShapes !== undefined ? { distinctShapes } : {}), ...(level2 && shapes ? { shapes } : {}) })),
      blocks: projectedBlocks,
    };
  }
  const dedupe = options.dedupe && full.dedupe ? full.dedupe : null;
  return { ...full, privacy: { ...full.privacy, level: options.level, reviewedByUser: options.reviewed, dedupe: dedupe !== null }, structure, dedupe };
}
