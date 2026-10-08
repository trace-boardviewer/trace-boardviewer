/**
 * Library knowledge: the pure recognition rules the Library uses to understand a technician's files.
 *
 * Pure, total, linear-time, no input or output. Everything here may run in the library service, the sandboxed indexer page or a
 * test. The data tables are CC0 (see the header of each table).
 *
 *   board numbers   recognizeBoardNumbers (shape table in board-number-shapes.ts)
 *   revisions       parseRevisions, compareRevisions
 *   hints           vendorHints, deviceTypeHints, documentTypeHints (word lists in lexicon.ts)
 *   part numbers    normalizePartNumber, matchTier (family table in part-families.ts)
 *   token classes   classifyToken, tokenizeText
 *   names           analyzePath
 *   identifiers     textIdentifiers, pathIdentifiers, partTermKeys (results as rows of the Library model)
 */

/**
 * Version of the knowledge tables and rules. The Library stores it with the results of the "name" and "knowledge" stages and
 * recomputes them when it changes; bump it with every change of a table or a rule that can change a result.
 */
export const KNOWLEDGE_VERSION = 1;

export * from './chars';
export * from './lexicon';
export * from './board-number-shapes';
export * from './board-numbers';
export * from './revision';
export * from './hints';
export * from './part-families';
export * from './part-numbers';
export * from './tokens';
export * from './names';
export * from './identifiers';
