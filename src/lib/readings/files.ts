/**
 * What kind of readings file the technician picked: a TRACE readings pack, a CSV table or an OpenBoardData text file. The content
 * decides; the name only breaks a tie. The main process reads the file (`trace:import-readings`: bounded, decoded to text) and the
 * renderer parses it with pack.ts, csv.ts or openboarddata.ts.
 */
import { CSV_COLUMNS } from './csv';
import { looksLikeOpenBoardData } from './openboarddata';

export type ReadingsFileKind = 'pack' | 'csv' | 'openboarddata';

export function detectReadingsFile(name: string, text: string): ReadingsFileKind | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const head = body.slice(0, 4096);
  if (/^\s*\{/.test(head) && head.includes('"trace-readings"')) return 'pack';
  const firstLine = head.split(/\r\n|\n|\r/, 1)[0].toLowerCase();
  const names = firstLine.split(/[,;\t]/).map(cell => cell.trim().replace(/^"|"$/g, ''));
  const columns = new Set<string>(CSV_COLUMNS);
  if (names.includes('kind') && names.filter(cell => columns.has(cell)).length >= 2) return 'csv';
  if (looksLikeOpenBoardData(body)) return 'openboarddata';
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'json' && /^\s*\{/.test(head)) return 'pack';
  if (extension === 'csv' || extension === 'tsv') return 'csv';
  return null;
}
