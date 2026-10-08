/** Original CSV table fixture; no vendor text is included. */
import { BV_SYNTHETIC_NAILS, BV_SYNTHETIC_PINS } from './bv-fixtures';
const cell = (value: unknown): string => { const text = String(value ?? ''); return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
export function syntheticBv2(options: { group?: boolean; eol?: string; name?: string; net?: string } = {}): string {
  const rows: string[] = ['#Layout#', options.group === false ? 'X,Y,R' : 'X,Y,R,Group'];
  for (const [x, y] of [[0, 0], [2, 0], [2, 1], [0, 1]]) rows.push([x, y, 0, ...(options.group === false ? [] : [2])].join(','));
  rows.push('#Nail#', 'Nail,X,Y,Type,Grid,TB,Net,NetName');
  for (const row of BV_SYNTHETIC_NAILS) rows.push(['Nail', 'X', 'Y', 'Type', 'Grid', 'TB', 'NET', 'NetName'].map(key => cell(row[key])).join(','));
  rows.push('#Pin#', 'Part,TB,Pin,Name,X,Y,Layer,Netname');
  BV_SYNTHETIC_PINS.forEach((original, index) => { const row = index === 0 ? { ...original, ...(options.name === undefined ? {} : { Name: options.name }), ...(options.net === undefined ? {} : { Net: options.net }) } : original; rows.push(['Part', 'TB', 'Pin', 'Name', 'X', 'Y', 'Layer', 'Net'].map(key => cell(row[key])).join(',')); });
  return rows.join(options.eol ?? '\n') + (options.eol ?? '\n');
}
