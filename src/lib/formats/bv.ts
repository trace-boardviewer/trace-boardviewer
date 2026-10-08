/** Original Jet BV boardview mapping: Layout, Pin and Nail scalar tables; coordinates are in inches. */
import type { Board } from '../types';
import type { ParseInput } from './common';
import { BV_FORMAT, isJetDatabase, JetDatabase } from './bv-jet';
import { assembleBvTables } from './bv-model';
import type { StructureHook } from './structure-hook';

/** Database framing only: declared row counts, engine version and units; no table cells or names are reported. */
export const bvHook: StructureHook = {
  id: 'bv', kind: 'binary', keywords: [], steps: ['header', 'container'],
  collect(input, sink) {
    if (!isJetDatabase(input.data)) return;
    sink.reached('header'); sink.units('inch', 25.4); sink.padAngle('none');
    let db: JetDatabase;
    try { db = new JetDatabase(input.data); } catch { return; }
    sink.variant(db.version === 3 ? 'bv-jet3' : 'bv-jet4'); sink.code('version', db.version);
    try {
      sink.count('declaredOutlinePoints', db.declaredRows('Layout'));
      sink.count('declaredPins', db.declaredRows('Pin'));
      sink.count('declaredNails', db.declaredRows('Nail'));
    } catch { return; }
    sink.reached('container');
  },
};

export function parseBv(input: ParseInput): Board | null {
  if (!isJetDatabase(input.data)) return null;
  const db = new JetDatabase(input.data), layoutColumns = ['X', 'Y', 'R'], hasGroup = db.columnNames('Layout').includes('Group');
  if (hasGroup) layoutColumns.push('Group');
  const layout = db.table('Layout', layoutColumns, 200_000), pins = db.table('Pin', ['Part', 'TB', 'Pin', 'Name', 'X', 'Y', 'Layer', 'Net'], 1_000_000);
  const nails = db.table('Nail', ['Nail', 'X', 'Y', 'Type', 'Grid', 'TB', 'NET', 'NetName', 'VirtualPinVia'], 1_000_000 - pins.count);
  return assembleBvTables(input, { layout: layout.rows, pins: pins.rows, nails: nails.rows, hasGroup }, BV_FORMAT);
}
