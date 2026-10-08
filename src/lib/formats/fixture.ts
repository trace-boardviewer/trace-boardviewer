/*
 * Shared shape of the synthetic samples every adapter folder provides in fixtures.ts (original TRACE module, MIT). Only
 * tests import them (registry.test.ts, conformance.test.ts): they never reach the application bundle. Every sample is
 * written by hand or by a generator in the test code; no vendor, customer or downloaded file is ever used.
 */
import type { ParseOptions } from './common';

export interface AdapterFixture {
  /** What the sample shows ("plain text", "rotated-byte encoded"). */
  readonly label: string;
  /** The file name the sample is opened with (its extension is the adapter's). */
  readonly name: string;
  readonly data: Uint8Array;
  readonly companions?: Readonly<Record<string, Uint8Array>>;
  readonly options?: ParseOptions;
  /** 'board' (default): the adapter reads it; 'refused': the adapter names it and refuses it with UNSUPPORTED_VARIANT. */
  readonly expect?: 'board' | 'refused';
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const lines = (rows: readonly string[], eol = '\n'): Uint8Array => utf8(rows.join(eol) + eol);
