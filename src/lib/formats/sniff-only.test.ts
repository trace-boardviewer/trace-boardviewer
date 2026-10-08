import { expect, it, vi } from 'vitest';
vi.mock('./registry', async importOriginal => {
 const actual = await importOriginal<typeof import('./registry')>();
 return { ...actual, BOARD_ADAPTERS: actual.BOARD_ADAPTERS.map(adapter => ({ ...adapter, parse: () => { throw new Error('parse must not run'); } })), CONTAINER_ADAPTERS: actual.CONTAINER_ADAPTERS.map(adapter => ({ ...adapter, open: () => { throw new Error('unpack must not run'); } })) };
});
import { sniffBoard, SNIFF_BYTES } from './index';
it('only reads the bounded head and never parses or opens a container', () => {
 const head = new TextEncoder().encode('(kicad_pcb (version 20240108))');
 expect(sniffBoard(head, 'board.kicad_pcb').best?.id).toBe('kicad');
 expect(sniffBoard(Uint8Array.from([80,75,3,4]), 'board.zip').best?.id).toBe('zip');
 const large = new Uint8Array(SNIFF_BYTES * 8).fill(32);
 large.set(head, SNIFF_BYTES + 2);
 expect(sniffBoard(large, 'board.kicad_pcb').best?.confidence ?? 0).toBeLessThan(90);
});
