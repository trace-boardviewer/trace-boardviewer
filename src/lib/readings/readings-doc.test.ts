import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from './csv';
import { EVENT_TYPES, METER_MODES, POLARITIES, POWER_STATES, PROVENANCE_ORIGINS, READING_KINDS, READING_SOURCES, READING_UNITS, READINGS_LIMITS, validatePack } from './schema';

const doc = readFileSync(new URL('../../../docs/READINGS_FORMAT.md', import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('../../../docs/readings-v1.schema.json', import.meta.url), 'utf8'));

describe('readings format documentation', () => {
  it('keeps JSON Schema enums and bounds equal to the runtime contract', () => {
    const defs = schema.$defs;
    expect(defs.reading.properties.kind.enum).toEqual([...READING_KINDS]);
    expect(defs.reading.properties.unit.enum).toEqual([...READING_UNITS]);
    expect(defs.reading.properties.source.enum).toEqual([...READING_SOURCES]);
    expect(defs.conditions.properties.power.enum).toEqual([...POWER_STATES]);
    expect(defs.conditions.properties.polarity.enum).toEqual([...POLARITIES]);
    expect(defs.conditions.properties.meterMode.enum).toEqual([...METER_MODES]);
    expect(defs.provenance.properties.origin.enum).toEqual([...PROVENANCE_ORIGINS]);
    expect(schema.properties.readings.maxItems).toBe(READINGS_LIMITS.readings);
    expect(defs.reading.properties.value.maximum).toBe(READINGS_LIMITS.value);
    expect(defs.tolerance.properties.rel.maximum).toBe(READINGS_LIMITS.rel);
  });

  it('documents a valid pack, every event and the complete CSV header', () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(doc)!;
    const pack = JSON.parse(example[1]);
    expect(validatePack(pack)).toEqual(pack);
    for (const event of EVENT_TYPES) expect(doc).toContain(event);
    expect(doc).toContain(CSV_COLUMNS.join(','));
    expect(doc).toContain('power-loss durability');
  });
});
