/**
 * Fuzz targets of the readers underneath the adapters, called directly because no registry entry reaches them on their own: the XML
 * scanner of IPC-2581, the CSV tokenizer and the column analysis of the pin list, the IPC-D-356 text reader, the compound-file container
 * of Altium and the ZIP reader of EasyEDA Pro. The adapters themselves (their sniffs, their parses, the containers) are taken from the
 * registry by targets.ts.
 */
import { BoardFormatError, decodeText, TextDecodeError } from '../../src/lib/formats/common';
import { readCompound } from '../../src/lib/formats/altium-cfb';
import type { CompoundFail } from '../../src/lib/formats/altium-cfb';
import { openZip, ZIP_MAX_ENTRIES } from '../../src/lib/formats/easyeda-zip';
import { XmlScanner } from '../../src/lib/formats/ipc2581-xml';
import { IPC356_MAX_FEATURES, readIpc356, readIpc356Record } from '../../src/lib/formats/ipc356';
import { analysePinList } from '../../src/lib/formats/pinlist-csv';
import { CSV_DELIMITERS, CsvTokenizer, DEFAULT_CSV_LIMITS, decodeChunks, detectEncoding } from '../../src/lib/formats/pinlist-csv-reader';
import type { CsvRecord } from '../../src/lib/formats/pinlist-csv-reader';
import type { FuzzInput } from './corpus';
import { createRng } from './prng';
import type { FuzzTarget } from './targets';

// The helpers of targets.ts are repeated, not imported: targets.ts imports this file.
const FORMAT_CODES: ReadonlySet<string> = new Set(['INVALID_FORMAT', 'UNRECOGNIZED', 'LIMIT_EXCEEDED', 'KEY_REQUIRED', 'INVALID_KEY', 'COMPANIONS_REQUIRED', 'UNSUPPORTED_VARIANT', 'WRONG_KIND', 'AMBIGUOUS_FORMAT']);
const isFormatError = (error: unknown): boolean => error instanceof BoardFormatError && FORMAT_CODES.has(error.code);

const asText = (input: FuzzInput): string => new TextDecoder('windows-1252').decode(input.data);

/** Runs `work`; a failure of the documented kind becomes data (so two runs can be compared), any other failure propagates as a finding. */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };
function attempt<T>(work: () => T, documented: (error: unknown) => boolean = isFormatError): Attempt<T> {
  try { return { ok: true, value: work() }; } catch (error) {
    if (!documented(error)) throw error;
    return { ok: false, error: `${(error as { code?: string }).code ?? ''}:${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Low-level readers
// ---------------------------------------------------------------------------------------------------------------

/** Cut points for feeding a text in pieces: a pure function of the text, so a finding reproduces. */
function cuts(text: string): number[] {
  const rng = createRng('cuts', text.length, text.charCodeAt(text.length >> 1) || 0, text.charCodeAt(0) || 0);
  const points: number[] = [];
  const count = rng.range(1, 24);
  for (let index = 0; index < count; index++) points.push(rng.chance(0.3) ? rng.range(1, 8) + (points[points.length - 1] ?? 0) : rng.int(text.length + 1));
  return [...new Set(points.filter(point => point > 0 && point < text.length))].sort((a, b) => a - b);
}

function xmlEvents(text: string, cutPoints: readonly number[]): string {
  const events: string[] = [];
  const scanner = new XmlScanner({
    open: (name, attributes, depth) => { events.push(`<${depth} ${name} ${attributes.join('\u0001')}`); },
    close: (name, depth) => { events.push(`>${depth} ${name}`); },
    doctype: doctype => { events.push(`!${JSON.stringify(doctype)}`); return true; },
  }, 'XML');
  let at = 0;
  for (const point of cutPoints) { scanner.write(text.slice(at, point)); at = point; }
  scanner.write(text.slice(at));
  scanner.end();
  return events.join('\n');
}

const compoundFail: CompoundFail = (message, code) => { throw new BoardFormatError(message, code, 'compound'); };

function csvRecords(text: string, delimiter: (typeof CSV_DELIMITERS)[number], cutPoints: readonly number[]): CsvRecord[] {
  const records: CsvRecord[] = [];
  const tokenizer = new CsvTokenizer(delimiter, record => { records.push(record); }, DEFAULT_CSV_LIMITS);
  let at = 0;
  for (const point of cutPoints) { tokenizer.push(text.slice(at, point)); at = point; }
  tokenizer.push(text.slice(at), true);
  return records;
}

const lowLevelTargets = (): FuzzTarget[] => [
  {
    // The scanner gives the same events (or the same failure) however the text is cut into pieces, and finds every start and end tag.
    id: 'util:xml-scanner', family: 'util', seeds: ['ipc2581', 'eagle', 'eagle-sch'],
    run: input => { const text = asText(input); return { whole: attempt(() => xmlEvents(text, [])), pieces: attempt(() => xmlEvents(text, cuts(text))) }; },
    allowed: () => false,
    check: output => {
      const { whole, pieces } = output as { whole: Attempt<string>; pieces: Attempt<string> };
      if (whole.ok !== pieces.ok) return 'cutting the text into pieces changes whether it is accepted';
      if (whole.ok && pieces.ok && whole.value !== pieces.value) return 'cutting the text into pieces changes the events';
      if (!whole.ok && !pieces.ok && whole.error.split(':')[0] !== pieces.error.split(':')[0]) return 'cutting the text into pieces changes the kind of failure';
      if (whole.ok) {
        let depth = 0;
        for (const event of whole.value.split('\n')) { if (event.startsWith('<')) depth++; else if (event.startsWith('>')) depth--; if (depth < 0) return 'an end tag without a start tag'; }
        if (depth !== 0) return 'the document ended with an open element';
      }
      return null;
    },
    units: output => { const { whole } = output as { whole: Attempt<string> }; return whole.ok ? whole.value.length : 0; },
  },
  {
    // Records and fields obey the limits and do not depend on how the text arrives.
    id: 'util:csv-tokenizer', family: 'util', seeds: ['pinlist', 'ipc356'],
    run: input => {
      const guess = detectEncoding(input.data);
      if (!guess) return null;
      const text = [...decodeChunks(input.data, guess)].join('');
      const delimiter = CSV_DELIMITERS[(input.data.length + (input.data[0] ?? 0)) % CSV_DELIMITERS.length];
      return { whole: attempt(() => csvRecords(text, delimiter, [])), pieces: attempt(() => csvRecords(text, delimiter, cuts(text))) };
    },
    allowed: isFormatError,
    check: output => {
      const { whole, pieces } = output as { whole: Attempt<CsvRecord[]>; pieces: Attempt<CsvRecord[]> };
      if (whole.ok && pieces.ok) {
        if (JSON.stringify(whole.value) !== JSON.stringify(pieces.value)) return 'cutting the text into pieces changes the records';
        let line = 0;
        for (const record of whole.value) {
          if (record.fields.length > DEFAULT_CSV_LIMITS.maxFields) return `a record of ${record.fields.length} fields`;
          if (record.fields.some(field => field.length > DEFAULT_CSV_LIMITS.maxFieldChars)) return 'a field longer than the limit';
          if (!(record.line >= line)) return 'record lines do not increase';
          line = record.line;
        }
      }
      return null;
    },
    units: output => { const { whole } = output as { whole: Attempt<CsvRecord[]> }; return whole.ok ? whole.value.length : 0; },
  },
  {
    id: 'util:ipc356-text', family: 'util', seeds: ['ipc356', 'pinlist'],
    run: input => {
      const text = decodeText(input.data);
      const document = readIpc356(text);
      // Every line also on its own: a record is a number list or nothing.
      let unreadable = 0;
      for (const line of text.split(/\r\n|\r|\n/, 2000)) { const record = readIpc356Record(line.slice(0, 400)); if (record && !(Number.isFinite(record.x) && Number.isFinite(record.y))) unreadable++; }
      return { document, unreadable };
    },
    allowed: error => isFormatError(error) || error instanceof TextDecodeError,
    check: output => {
      const { document, unreadable } = output as { document: ReturnType<typeof readIpc356>; unreadable: number };
      if (unreadable) return 'a record line gave a coordinate that is not finite';
      if (document.features.length > IPC356_MAX_FEATURES) return `${document.features.length} features`;
      for (const feature of document.features) {
        if (![feature.x, feature.y, feature.xSize, feature.ySize, feature.rotation].every(Number.isFinite)) return 'a feature has a number that is not finite';
        if (!(feature.rotation >= 0 && feature.rotation < 360)) return `a rotation of ${feature.rotation}`;
      }
      return null;
    },
    units: output => (output as { document: ReturnType<typeof readIpc356> }).document.features.length,
  },
  {
    // The compound file container: whatever it lets out stays inside the extraction budget (twice the size of the file).
    id: 'util:compound-file', family: 'util', seeds: ['altium', 'altium-sch'],
    run: input => {
      const compound = readCompound(input.data, compoundFail);
      let produced = 0;
      for (const path of compound.paths.slice(0, 200)) { try { produced += compound.stream(path)?.length ?? 0; } catch (error) { if (!isFormatError(error)) throw error; break; } }
      return { paths: compound.paths.length, produced };
    },
    allowed: isFormatError,
    check: (output, input) => { const { produced } = output as { produced: number }; return produced <= input.data.length * 2 ? null : `${produced} bytes out of a file of ${input.data.length}`; },
    units: output => (output as { paths: number }).paths,
  },
  {
    // The ZIP container: entries are listed without inflating; an entry is inflated to its declared size or refused, never beyond.
    id: 'util:zip', family: 'util', seeds: ['easyeda-pro'],
    run: input => {
      const archive = openZip(input.data, 'ZIP');
      if (!archive) return null;
      let produced = 0;
      for (const entry of archive.entries.slice(0, 64)) {
        try { const bytes = archive.read(entry, 1 << 20); if (bytes.length !== entry.size) throw new Error(`entry "${entry.name.slice(0, 40)}" gave ${bytes.length} bytes, not the declared ${entry.size}`); produced += bytes.length; }
        catch (error) { if (!isFormatError(error)) throw error; }
      }
      return { entries: archive.entries.length, produced };
    },
    allowed: isFormatError,
    check: output => { const { entries } = output as { entries: number }; return entries <= ZIP_MAX_ENTRIES ? null : `${entries} entries`; },
    units: output => (output as { entries: number }).entries,
  },
];

/** The column analysis of the pin list (what the mapping dialog would show) is total on any bytes, with or without options. */
const pinListAnalysis: FuzzTarget = {
  id: 'util:pinlist-analysis', family: 'util', seeds: ['pinlist'],
  run: input => analysePinList(input.data, input.options?.pinList) ?? null,
  allowed: () => false,
  check: output => {
    const confidence = (output as { confidence?: unknown }).confidence;
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return `the confidence is ${String(confidence)}`;
    const reason = (output as { reason?: unknown }).reason;
    return typeof reason === 'string' && reason.length > 1000 ? `a reason of ${reason.length} characters` : null;
  },
  digest: output => JSON.stringify(output),
};

/** The targets of the readers underneath the adapters. */
export const lowLevelReaderTargets = (): FuzzTarget[] => [...lowLevelTargets(), pinListAnalysis];
