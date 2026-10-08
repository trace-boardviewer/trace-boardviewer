import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { BOARD_ADAPTERS, parseBoard, sniffBoard } from './index';
import { utf8 } from './fixture';
import proFixtures from './adapters/easyeda-pro/fixtures';
import { unzipSync } from 'fflate';
import { sniffDocument } from '../../app/sniff';
import { loadSchematicDesign } from '../schematic';
import { divider } from '../schematic/altium-sch-fixtures';

describe('registered readers through public imports', () => {
 it('keeps EasyEDA archive companions when the project begins beyond the head', () => {
  const files = unzipSync(proFixtures[0].data);
  const data = zipSync({ 'readme.txt': new Uint8Array(70 * 1024).fill(65), ...files }, { level: 0 });
  expect(sniffBoard(data.subarray(0, 65536), 'backup.zip', data.length).best?.id).toBe('zip');
  const board = parseBoard({ name: 'backup.zip', data });
  expect(board.pins.length).toBeGreaterThan(0);
  expect(board.format).toContain('EasyEDA Pro');
 });
 it('carries explicit pin-list mappings past the automatic claim rule', () => {
  const board = parseBoard({ name: 'mapped.csv', data: utf8('item,terminal,horizontal,vertical,signal\nU1,1,2,3,GND\n'), options: { pinList: { mapping: { refdes: 0, pin: 1, x: 2, y: 3, net: 4 }, unit: 'mm' } } });
  expect(board.pins[0]).toMatchObject({ number: '1', x: 2, y: 3, net: 'GND' });
 });
 it('routes Altium schematic bytes through document detection, parsing and connectivity', () => {
  for (const data of [divider().ascii(), divider().file()]) {
   expect(sniffDocument(data)).toEqual({ kind: 'schematic', format: 'altium-sch' });
   const design = loadSchematicDesign({ name: 'Divider.SchDoc', data });
   expect(design.schematic.format).toBe('altium-sch');
   expect(design.connectivity.nets.length).toBeGreaterThan(0);
  }
 });
 it('states real-file limitations with the supported reader status', () => {
  expect(BOARD_ADAPTERS.find(adapter => adapter.id === 'easyeda-pro')?.capability).toMatchObject({ status: 'supported', validation: 'real-files' });
  expect(BOARD_ADAPTERS.find(adapter => adapter.id === 'altium')?.capability.notes.join(' ')).toContain('28 openly licensed boards');
 });
});
