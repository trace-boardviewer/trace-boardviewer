import { describe, expect, it } from 'vitest';
import { parseReadingsCsv, readingsToCsv } from './csv';
import { auditPack, buildPack, parsePack, planImport, serializePack } from './pack';
import { DEFAULT_PACK_LICENSE, validateReading } from './schema';
import type { Reading } from './schema';
import { pick, randomReadings, seeded } from './testing-corpus';

const voltage = (id: string, extra: Record<string, unknown> = {}): Reading => validateReading({ id, kind: 'voltage', target: { net: 'PP3V3' }, value: 3.3, unit: 'V', conditions: { power: 'powered' }, source: 'known-good', ...extra });
const odbl = (id: string): Reading => voltage(id, { source: 'imported', license: 'ODbL-1.0', provenance: { origin: 'openboarddata', title: '820-00165' } });
const BOARD = { fingerprint: 'a'.repeat(64), fingerprintVersion: 1, label: 'Logic board', boardNumber: '820-00165' };

describe('readings pack round trip (property)', () => {
  it('parsePack(serializePack(pack)) equals the pack, and serializing again gives the same bytes, for 300 generated packs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const readings = randomReadings(random, Math.floor(random() * 40));
      const options = {
        board: { ...(random() < 0.7 ? BOARD : {}), ...(random() < 0.3 ? { fileKeys: ['b'.repeat(64)], pinSet: [['R1', ['1', '2']], ['U7', ['3']]] as const } : {}) },
        license: pick(random, [undefined, 'CC0-1.0', 'CC-BY-4.0']),
        foreign: pick(random, ['exclude', 'mark'] as const),
        ...(random() < 0.5 ? { title: 'Known-good set "A", rev 2', attribution: 'Typed by the shop', createdAt: '2026-10-07T10:00:00Z' } : {}),
      };
      const { pack } = buildPack(readings, options);
      const text = serializePack(pack);
      const parsed = parsePack(text);
      expect(parsed, `seed ${seed}`).toEqual({ ok: true, pack });
      if (parsed.ok) expect(serializePack(parsed.pack), `seed ${seed}`).toBe(text);
      expect(JSON.parse(text), `seed ${seed}`).toEqual(pack);
    }
  });

  it('a CSV round trip of the same readings is identical too (300 generated lists)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const readings = randomReadings(seeded(seed * 7919), 30, `c${seed}-`);
      const parsed = parseReadingsCsv(readingsToCsv(readings));
      expect(parsed.issues, `seed ${seed}`).toEqual([]);
      expect(parsed.readings, `seed ${seed}`).toEqual(readings);
    }
  });
});

describe('buildPack and licences', () => {
  it('is CC0-1.0 by default; readings under another licence are left out unless marked', () => {
    const own = voltage('r1');
    const built = buildPack([own, odbl('o1')], { board: BOARD });
    expect(built.pack.license).toBe(DEFAULT_PACK_LICENSE);
    expect(built.pack.readings).toEqual([own]);
    expect(built.excluded.map(reading => reading.id)).toEqual(['o1']);
    expect(built.pack.licenses).toBeUndefined();
    const marked = buildPack([own, odbl('o1')], { board: BOARD, foreign: 'mark' });
    expect(marked.pack.licenses).toEqual(['CC0-1.0', 'ODbL-1.0']);
    expect(marked.pack.readings[1]).toMatchObject({ license: 'ODbL-1.0', provenance: { origin: 'openboarddata', title: '820-00165' } });
    expect(marked.excluded).toEqual([]);
    expect(buildPack([odbl('o1')], { board: BOARD, license: 'ODbL-1.0' }).pack).toMatchObject({ license: 'ODbL-1.0', readings: [{ id: 'o1' }] });
  });

  it('the file holds names and values only: the pack text has no coordinates, paths or user names', () => {
    const text = serializePack(buildPack([voltage('r1', { target: { ref: 'U7', pin: '3', net: 'PP3V3' } })], { board: BOARD }).pack);
    expect(text).not.toMatch(/"(x|y|side|position|outline|path|user|author|file)"\s*:/);
    expect(text.split('\n').slice(0, 5)).toEqual(['{', '  "format": "trace-readings",', '  "version": 1,', '  "license": "CC0-1.0",', `  "board": ${JSON.stringify(BOARD)},`]);
  });

  it('parsePack never throws: not JSON, too large, invalid', () => {
    expect(parsePack('{')).toEqual({ ok: false, code: 'READINGS_INVALID', message: 'Invalid readings: the pack is not JSON.' });
    expect(parsePack('{"format":"trace-readings","version":1,"license":"CC0-1.0","board":{},"readings":[{"id":"r1"}]}')).toEqual({ ok: false, code: 'READINGS_INVALID', message: 'Invalid readings: readings[0].kind.' });
    expect(parsePack(`\ufeff${serializePack(buildPack([], { board: {} }).pack)}`).ok).toBe(true);
    expect(parsePack(' '.repeat(64 * 1024 * 1024 + 1))).toMatchObject({ ok: false, code: 'READINGS_TOO_LARGE' });
  });
});

describe('planImport', () => {
  const now = '2026-10-07T12:00:00Z';
  let next = 0;
  const newId = () => `new${++next}`;
  it('known-good readings of a file become imported, with the file\'s licence and a provenance; measured ones stay measured', () => {
    const plan = planImport([voltage('r1'), voltage('m1', { source: 'measured' })], { origin: 'trace-pack', license: 'CC0-1.0', title: 'Set A', attribution: 'Typed by the shop' }, null, { now, newId });
    expect(plan.readings[0]).toMatchObject({ id: 'r1', source: 'imported', license: 'CC0-1.0', provenance: { origin: 'trace-pack', title: 'Set A', attribution: 'Typed by the shop', sourceId: 'r1', importedAt: now } });
    expect(plan.readings[1]).toMatchObject({ id: 'm1', source: 'measured', license: 'CC0-1.0' });
    expect(plan.unchanged).toBe(0);
  });
  it('a second import of the same file adds nothing; a different reading under a taken id gets a new id', () => {
    const first = planImport([voltage('r1'), odbl('o1')], { origin: 'trace-pack', license: 'CC0-1.0' }, null, { now, newId });
    const existing = new Map(first.readings.map(reading => [reading.id, reading]));
    const again = planImport([voltage('r1'), odbl('o1')], { origin: 'trace-pack', license: 'CC0-1.0' }, existing, { now: '2026-10-08T00:00:00Z', newId });
    expect(again).toEqual({ readings: [], unchanged: 2, renamed: [] });
    const changed = planImport([voltage('r1', { value: 3.2 })], { origin: 'trace-pack', license: 'CC0-1.0' }, existing, { now, newId });
    expect(changed.renamed).toEqual([{ from: 'r1', to: 'new1' }]);
    expect(changed.readings[0]).toMatchObject({ id: 'new1', value: 3.2, provenance: { sourceId: 'r1' } });
  });
  it('an ODbL reading keeps its own licence and provenance in a CC0 file', () => {
    const plan = planImport([odbl('o1')], { origin: 'trace-pack', license: 'CC0-1.0' }, null, { now, newId });
    expect(plan.readings[0]).toMatchObject({ license: 'ODbL-1.0', provenance: { origin: 'openboarddata', title: '820-00165' } });
  });
});

describe('auditPack (the "contains no file content" check)', () => {
  it('lists typed text that looks like a path, an e-mail address or a link; names and values pass', () => {
    const pack = buildPack([
      voltage('r1', { note: 'see C:\\boards\\logic.brd' }), voltage('r2', { note: 'ask shop@example.com' }), voltage('r3', { conditions: { power: 'powered', meter: 'https://x.test' } }),
      voltage('r4', { note: 'after reflow, 3.3 V / 1.8 V' }), voltage('r5', { raw: '/home/user/x' }),
    ], { board: { label: 'Logic board' }, title: 'From /Users/someone/Desktop' }).pack;
    expect(auditPack(pack)).toEqual([
      { field: 'title', kind: 'path' }, { field: 'readings[0].note', kind: 'path' }, { field: 'readings[1].note', kind: 'email' },
      { field: 'readings[2].conditions.meter', kind: 'url' }, { field: 'readings[4].raw', kind: 'path' },
    ]);
  });
});
