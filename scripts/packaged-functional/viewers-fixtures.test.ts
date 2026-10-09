import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBoard } from '../../src/lib/formats';
import { loadSchematicDesign } from '../../src/lib/schematic';
import { buildBoardIndex } from '../../src/lib/board-index';
import { buildSchematicIndex, mapSchematicNetToBoard, mapSchematicSelectionToBoard } from '../../src/lib/crossprobe';
import { panBy } from '../../src/lib/geometry';

const require = createRequire(import.meta.url);
const { buildKnownBoardFixture, buildKicadHierarchyFixtures, panCamera, registerViewerFixtures, sameCanonicalPath, sameCanonicalPathStrings } = require('./viewers.cjs') as {
  buildKnownBoardFixture(): Uint8Array;
  buildKicadHierarchyFixtures(): { root: string; child: string };
  panCamera(camera: { zoom: number; x: number; y: number; rotation: number; side: 'top' | 'bottom' }, screenDelta: { x: number; y: number }): { zoom: number; x: number; y: number; rotation: number; side: 'top' | 'bottom' };
  registerViewerFixtures(context: { registerFixture(name: string, data: Uint8Array): Promise<string> }): Promise<Record<string, string>>;
  sameCanonicalPath(actualPath: string, expectedPath: string, platform?: string): Promise<boolean>;
  sameCanonicalPathStrings(actual: string, expected: string, platform?: string): boolean;
};
const bytes = (value: string) => new TextEncoder().encode(value);

describe('packaged viewer camera oracle', () => {
  it('maps keyboard screen deltas through the production rotation and mirror transform', () => {
    for (const camera of [
      { zoom: 4, x: 20, y: 15, rotation: 90, side: 'top' as const },
      { zoom: 4, x: 20, y: 15, rotation: 90, side: 'bottom' as const },
      { zoom: 2, x: -3, y: 8, rotation: 270, side: 'bottom' as const },
    ]) {
      const screenDelta = { x: 0, y: -40 };
      const expected = panBy({
        center: { x: camera.x, y: camera.y }, scale: camera.zoom,
        rotation: camera.rotation, mirrored: camera.side === 'bottom',
      }, screenDelta);
      expect(panCamera(camera, screenDelta)).toEqual({
        ...camera, x: expected.center.x, y: expected.center.y,
      });
    }
  });
});

describe('packaged viewer canonical path oracle', () => {
  it('resolves a filesystem alias before comparing the production path with the fixture path', async ({ skip }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-viewer-path-'));
    try {
      const target = path.join(root, 'target');
      const alias = path.join(root, 'alias');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'board.cad'), 'synthetic');
      try {
        await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(code || '')) skip(`host does not support directory aliases (${code})`);
        throw error;
      }
      const targetBoard = path.join(target, 'board.cad');
      const aliasBoard = path.join(alias, 'board.cad');
      expect(targetBoard).not.toBe(aliasBoard);
      expect(await sameCanonicalPath(targetBoard, aliasBoard)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('simulates POSIX case-sensitive comparison separately from native filesystem coverage', () => {
    expect(sameCanonicalPathStrings('/tmp/Board.cad', '/tmp/board.cad', 'darwin')).toBe(false);
    expect(sameCanonicalPathStrings('/tmp/Board.cad', '/tmp/board.cad', 'linux')).toBe(false);
    expect(sameCanonicalPathStrings('C:\\Boards\\Board.cad', 'c:\\boards\\board.cad', 'win32')).toBe(true);
  });
});

describe('packaged viewer known board baseline fixture', () => {
  it('parses through the production board dispatcher with exact U1, U10, and VCC targets', () => {
    const board = parseBoard({ name: 'viewer-known-board.cad', data: buildKnownBoardFixture() });
    expect(board.format).toBe('GENCAD 1.4');
    expect(board.components.map(component => component.ref).sort()).toEqual(['PU301', 'U1', 'U10']);
    expect(board.nets.map(net => net.name).sort()).toEqual(['GND', 'VCC']);
  });
});

describe('packaged viewer authored KiCad hierarchy fixture', () => {
  it('parses a root and same-directory child sheet through the production schematic adapter', () => {
    const { root, child } = buildKicadHierarchyFixtures();
    const design = loadSchematicDesign({
      name: 'viewer-hierarchical.kicad_sch',
      data: bytes(root),
      companions: { 'viewer-channel.kicad_sch': bytes(child) },
    });

    expect(design.schematic.format).toBe('kicad-sch');
    expect(design.schematic.instances.map(instance => instance.path)).toEqual([
      '', '/00000000-0000-4000-8000-000000000011',
    ]);
    expect(design.schematic.diagnostics.filter(item => item.severity !== 'info')).toEqual([]);
    expect(design.connectivity.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(design.connectivity.nets.flatMap(net => net.members).some(member => member.ref === 'U10')).toBe(true);
  });

  it('attaches a KiCad baseline whose U1 and VCC targets belong to the same known board', async () => {
    const registered = new Map<string, Uint8Array>();
    await registerViewerFixtures({ registerFixture: async (name, data) => { registered.set(name, data); return name; } });
    const data = registered.get('viewer-known-board.kicad_sch');
    expect(data).toBeDefined();
    const design = loadSchematicDesign({ name: 'viewer-known-board.kicad_sch', data: data! });
    expect(design.schematic.format).toBe('kicad-sch');
    expect(design.connectivity.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(design.connectivity.nets.map(net => net.name)).toContain('VCC');
    expect(design.connectivity.nets.flatMap(net => net.members).some(member => member.ref === 'U1')).toBe(true);
    const board = buildBoardIndex(parseBoard({ name: 'viewer-known-board.cad', data: buildKnownBoardFixture() }));
    const schematic = buildSchematicIndex([{ documentId: 'known-baseline', design }]);
    const u1 = schematic.partsByRef.get('U1')?.[0];
    expect(u1).toBeDefined();
    expect(mapSchematicSelectionToBoard(board, schematic, { documentId: 'known-baseline', instancePath: u1!.units[0].instancePath, symbolId: u1!.units[0].symbolId })).toMatchObject({ status: 'unique', candidates: [{ ref: 'U1', via: 'exact' }] });
    const vcc = schematic.nets.find(net => net.name === 'VCC');
    expect(vcc).toBeDefined();
    expect(mapSchematicNetToBoard(board, schematic, { documentId: 'known-baseline', netId: vcc!.id })).toMatchObject({ status: 'unique', candidates: [{ name: 'VCC', via: 'exact' }] });
  });

  it('reports an absent EAGLE net as unresolved instead of borrowing a match from another document', async () => {
    const registered = new Map<string, Uint8Array>();
    await registerViewerFixtures({ registerFixture: async (name, data) => { registered.set(name, data); return name; } });
    const data = registered.get('viewer-hierarchical.eagle.sch');
    expect(data).toBeDefined();
    const design = loadSchematicDesign({ name: 'viewer-hierarchical.eagle.sch', data: data! });
    const board = buildBoardIndex(parseBoard({ name: 'viewer-known-board.cad', data: buildKnownBoardFixture() }));
    const schematic = buildSchematicIndex([{ documentId: 'eagle-case', design }]);
    const sig = schematic.nets.find(net => net.name === 'SIG');
    expect(sig).toBeDefined();
    expect(mapSchematicNetToBoard(board, schematic, { documentId: 'eagle-case', netId: sig!.id })).toMatchObject({ status: 'missing', reasons: ['no-board-net'], candidates: [] });
    const u1 = schematic.partsByRef.get('U1')?.[0];
    expect(u1).toBeDefined();
    expect(mapSchematicSelectionToBoard(board, schematic, { documentId: 'eagle-case', instancePath: u1!.units[0].instancePath, symbolId: u1!.units[0].symbolId })).toMatchObject({ status: 'unique', candidates: [{ ref: 'U1', via: 'exact' }] });
  });
});
