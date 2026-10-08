/**
 * Where the seeds of the fuzzer come from: the JSON corpus (`tests/fuzz/corpus/<adapter>.json`, curated, with companions and options),
 * for every adapter that has no corpus file the synthetic samples of its own folder (`src/lib/formats/adapters/<id>/fixtures.ts`, the
 * files the conformance tests read), and the samples of the readings importers. A reader that is registered later with its fixtures is
 * therefore fuzzed from its first sample on, without a change here; a corpus file only has to be added to add seeds that the fixtures
 * do not offer.
 */
import type { AdapterFixture } from '../../src/lib/formats/fixture';
import { readingsToCsv } from '../../src/lib/readings/csv';
import { buildPack, serializePack } from '../../src/lib/readings/pack';
import { randomReadings, seeded } from '../../src/lib/readings/testing-corpus';
import { loadCorpus } from './corpus';
import type { Seed } from './corpus';

const FIXTURE_FILES = import.meta.glob<AdapterFixture[]>('../../src/lib/formats/adapters/*/fixtures.ts', { eager: true, import: 'default' });

/** The samples of the adapter folders as seeds: `valid` for the ones the adapter reads, `error` for the ones it names and refuses. */
export function fixtureSeeds(): Seed[] {
  const seeds: Seed[] = [];
  for (const [file, list] of Object.entries(FIXTURE_FILES).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const adapter = /adapters\/([^/]+)\/fixtures\.ts$/.exec(file)![1];
    list.forEach((fixture, index) => seeds.push({
      adapter, id: `fixture ${index}: ${fixture.label}`.slice(0, 120), kind: fixture.expect === 'refused' ? 'error' : 'valid',
      input: {
        name: fixture.name, data: fixture.data,
        ...(fixture.companions ? { companions: { ...fixture.companions } } : {}),
        ...(fixture.options ? { options: structuredClone(fixture.options) } : {}),
      },
    }));
  }
  return seeds;
}

const BOARD = { label: 'Sample board', boardNumber: '820-00000' };
const lines = (rows: readonly string[], eol = '\n'): string => rows.join(eol) + eol;

/**
 * Seeds of the readings importers (a CSV table, an OpenBoardData file, a readings pack), made in code from the generators the readings
 * tests use: deterministic, synthetic, nothing stored. Hand-written files add the dialects the generators do not write.
 */
export function readingsSeeds(): Seed[] {
  const seeds: Seed[] = [];
  const add = (adapter: string, id: string, name: string, text: string) => seeds.push({ adapter, id, kind: 'valid', input: { name, data: new TextEncoder().encode(text) } });
  [1, 3, 6, 12, 20].forEach((count, index) => add('readings-csv', `generated table ${index + 1}`, 'readings.csv', readingsToCsv(randomReadings(seeded(100 + index), count))));
  add('readings-csv', 'header only', 'readings.csv', lines(['kind,ref,pin,value,unit']));
  add('readings-csv', 'semicolons and decimal commas', 'readings.csv', lines(['kind;ref;pin;net;value;unit;power', 'voltage;U7;3;;1,8;V;powered', 'resistance;R1;1;PP3V3;4k7;ohm;unpowered']));
  add('readings-csv', 'few columns', 'readings.csv', lines(['kind,net,value,power', 'diode,PP3V3,0.412,unpowered', 'continuity,GND,true,unpowered', 'voltage,PP1V8,1.8V,powered']));
  [1, 3, 8].forEach((count, index) => {
    const { pack } = buildPack(randomReadings(seeded(200 + index), count), { board: BOARD, foreign: 'mark', title: 'Sample', createdAt: '2026-10-07T10:00:00Z' });
    add('readings-pack', `generated pack ${index + 1}`, 'readings.json', serializePack(pack));
  });
  add('readings-pack', 'empty pack', 'readings.json', '{"format":"trace-readings","version":1,"license":"CC0-1.0","board":{},"readings":[]}');
  add('readings-obd', 'one board', 'board.txt', lines(['ID 820-00165', 'BRAND Example', 'TYPE Laptop', 'COMMENT synthetic sample', 'PP3V3_S5 0.412 3.30 OL main rail', 'PP1V8 0.5 1.8 12k', 'GND 0 0 0']));
  add('readings-obd', 'two boards in one file', 'obd.txt', lines(['BOARD_A PP3V3 0.41 3.3 OL first', 'BOARD_A GND 0 0 0', 'BOARD_B PP3V3 0.43 3.3 12k second', 'BOARD_B PP1V8 0.55 1.8 4k7'], '\r\n'));
  add('readings-obd', 'sections and comments', 'board.txt', lines(['ID X1', '# comment', 'COMPONENT_START', 'U1 something', 'COMPONENT_END', 'NET1 0.5 1.2 4k7', 'NET2 - - 100']));
  add('readings-obd', 'millivolt diodes', 'board.txt', lines(['ID Y2', 'N1 412 3300 100k', 'N2 520 1800 OL']));
  return seeds;
}

/** The corpus files, then the fixtures of every adapter that has no corpus file, then the seeds of the readings importers. */
export function loadSeeds(corpusDirectory: string): Seed[] {
  const corpus = loadCorpus(corpusDirectory);
  const covered = new Set(corpus.map(seed => seed.adapter));
  return [...corpus, ...fixtureSeeds().filter(seed => !covered.has(seed.adapter)), ...readingsSeeds()];
}
