/**
 * The seed corpus and the regression fixtures of the parser fuzzer.
 *
 * Both are JSON: a list of entries, each one a primary file (`text` when it is plain text, `b64` otherwise), optional companion files and
 * optional import options. Every entry is a small SYNTHETIC input made for the adapter tests of this repository (never a real vendor
 * file); the corpus is a selection of them, grouped by the adapter whose tests produced them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ipc356Options } from '../../src/lib/formats/ipc356';
import type { PinListOptions } from '../../src/lib/formats/pinlist-csv';

/** The import options a fuzz input may carry: the keys of the encrypted formats, and the options of the readers that take some. */
export interface FuzzOptions { fzKey?: number[]; xzzKey?: string; ipc356?: Ipc356Options; pinList?: PinListOptions }

export interface FuzzInput {
  name: string;
  data: Uint8Array;
  companions?: Record<string, Uint8Array>;
  options?: FuzzOptions;
}

export interface PackedBytes { text?: string; b64?: string }
export interface PackedInput extends PackedBytes {
  name: string;
  companions?: Record<string, PackedBytes>;
  options?: FuzzOptions;
}
export interface CorpusEntry extends PackedInput {
  /** What the adapter made of it when the corpus was built: valid, error or null (not this format). */
  kind: string;
  id: string;
}
export interface Seed { adapter: string; id: string; kind: string; input: FuzzInput }

const isText = (bytes: Uint8Array): string | null => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null; // the decoder would drop the byte-order mark
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f﻿�]/.test(text) ? null : text;
  } catch { return null; }
};

export function packBytes(bytes: Uint8Array): PackedBytes {
  const text = isText(bytes);
  return text === null ? { b64: Buffer.from(bytes).toString('base64') } : { text };
}
export const unpackBytes = (packed: PackedBytes): Uint8Array => (packed.text !== undefined ? new TextEncoder().encode(packed.text) : new Uint8Array(Buffer.from(packed.b64 ?? '', 'base64')));

export function packInput(input: FuzzInput): PackedInput {
  const packed: PackedInput = { name: input.name, ...packBytes(input.data) };
  if (input.companions && Object.keys(input.companions).length) packed.companions = Object.fromEntries(Object.entries(input.companions).map(([name, bytes]) => [name, packBytes(bytes)]));
  if (input.options) packed.options = input.options;
  return packed;
}
export function unpackInput(packed: PackedInput): FuzzInput {
  const input: FuzzInput = { name: packed.name, data: unpackBytes(packed) };
  if (packed.companions) input.companions = Object.fromEntries(Object.entries(packed.companions).map(([name, bytes]) => [name, unpackBytes(bytes)]));
  if (packed.options) input.options = packed.options;
  return input;
}

/** Every `<adapter>.json` of the directory, as seeds. A missing directory gives no seeds. */
export function loadCorpus(directory: string): Seed[] {
  if (!existsSync(directory)) return [];
  const seeds: Seed[] = [];
  for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const adapter = file.replace(/\.json$/, '');
    const entries = JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as CorpusEntry[];
    for (const entry of entries) seeds.push({ adapter, id: entry.id, kind: entry.kind, input: unpackInput(entry) });
  }
  return seeds;
}

/** A saved crash: the minimized input plus what it showed. */
export interface RegressionFixture extends PackedInput {
  target: string;
  /** The kind of finding, for the reader; the replay only requires the input to be handled cleanly now. */
  finding: string;
  /** One line: what went wrong when the input was found. No paths, no stack. */
  note: string;
}

export function loadRegressions(directory: string): Array<{ file: string; fixture: RegressionFixture; input: FuzzInput }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(file => {
    const fixture = JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as RegressionFixture;
    return { file, fixture, input: unpackInput(fixture) };
  });
}

export const totalBytes = (input: FuzzInput): number => input.data.length + Object.values(input.companions ?? {}).reduce((sum, bytes) => sum + bytes.length, 0);
