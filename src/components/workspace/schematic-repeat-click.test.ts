import { describe, expect, it } from 'vitest';
import { SheetBuilder, buildSchematic } from '../../lib/schematic/testing';
import { createHarness, designOf, makeBoard, openNative, seedWorkspace } from '../../app/testing';
import type { Harness } from '../../app/testing';

// W-fin-crossprobe-01: the banner used to shift the canvas, so the SECOND click of the same pixel missed the wire. With the banner drawn as an
// overlay the viewer sends the SAME net again; these tests pin what the core does with that repeated selection (the contract the overlay fix relies on):
// the candidate list and the schematic selection stay, nothing is deselected. The pixel geometry itself is proven on the Electron app (evidence/dev-ui).

/** One schematic net carrying two names (SIGA, SIGB) and a plain GND. */
const design = () => designOf(buildSchematic([new SheetBuilder('root', 'alias')
  .part('R1', [{ n: '1', x: 0, y: 0 }, { n: '2', x: 0, y: 10 }])
  .part('R2', [{ n: '1', x: 20, y: 0 }, { n: '2', x: 20, y: 10 }])
  .wire(0, 0, 20, 0).local('SIGA', 5, 0).local('SIGB', 15, 0)
  .wire(0, 10, 20, 10).local('GND', 10, 10)]));
const board = () => makeBoard('a.cad', [
  { ref: 'R1', id: 'r1', pins: [['1', 'SIGA'], ['2', 'GND']] },
  { ref: 'R2', id: 'r2', pins: [['1', 'SIGB'], ['2', 'GND']] },
]);
async function open(): Promise<Harness> {
  const h = createHarness();
  seedWorkspace(h, 1, '/boards/a.cad', [{ id: 'doc-sch', path: '/boards/docs/top.kicad_sch', kind: 'schematic', key: 41 }]);
  h.schematicWorkers.designs['top.kicad_sch'] = design();
  await openNative(h, 'a.cad', 1, board());
  expect(h.state().documents[0].designState).toBe('ready');
  return h;
}

describe('repeated click on the same schematic wire (W-fin-crossprobe-01)', () => {
  it('an ambiguous net keeps its candidate list and its selection however often the same wire is clicked', async () => {
    const h = await open();
    const sig = h.state().documents[0].design!.connectivity.nets.find(net => net.aliases.includes('SIGB'))!;
    for (let click = 1; click <= 3; click++) {
      h.controller.actions.selectSchematicNet('doc-sch', sig.id);
      const probe = h.state().probe;
      expect(probe.boardNetMapping, `click ${click}`).toMatchObject({ status: 'ambiguous', total: 2 });
      expect(probe.boardNetMapping!.candidates.map(c => c.name), `click ${click}`).toEqual(['SIGA', 'SIGB']);
      expect(probe.schematic?.selection, `click ${click}`).toEqual({ netId: sig.id });
      expect(h.state().selection, `click ${click}`).toEqual({ componentId: null, pinId: null, net: null });
    }
  });
  it('a unique net stays selected on a repeated click and never raises a banner', async () => {
    const h = await open();
    const gnd = h.state().documents[0].design!.connectivity.nets.find(net => net.name === 'GND')!;
    for (let click = 1; click <= 3; click++) {
      h.controller.actions.selectSchematicNet('doc-sch', gnd.id);
      expect(h.state().selection, `click ${click}`).toEqual({ componentId: null, pinId: null, net: 'GND' });
      expect(h.state().probe.boardNetMapping, `click ${click}`).toMatchObject({ status: 'unique' });
      expect(h.state().probe.schematic?.selection, `click ${click}`).toEqual({ netId: gnd.id });
    }
  });
  it('choosing a candidate still resolves the banner and selects that board net', async () => {
    const h = await open();
    const sig = h.state().documents[0].design!.connectivity.nets.find(net => net.aliases.includes('SIGB'))!;
    h.controller.actions.selectSchematicNet('doc-sch', sig.id);
    h.controller.actions.selectSchematicNet('doc-sch', sig.id);
    h.controller.actions.chooseBoardNet(1);
    expect(h.state().selection.net).toBe('SIGB');
    expect(h.state().probe.boardNetMapping).toBeNull();
  });
});
