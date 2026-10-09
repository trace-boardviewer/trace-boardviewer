/*
 * ASC companion trio reader. File roles, header lengths and record layouts follow OpenBoardView's ASCFile.cpp (MIT,
 * Copyright (c) 2016 Chloridite and OpenBoardView contributors; see assets/licenses/openboardview-MIT.txt). Original code.
 */
import type { Board } from '../types';
import { BoardFormatError, decodeText, type ParseInput } from './common';
import { assemble, readFormat, readNails, readPins, reject, splitLines, Tally, type Model, type Row, type Source } from './bdv';

export const ASC_FORMAT = 'ASC companion trio';
type Role = 'format' | 'pins' | 'nails';
const ROLES: readonly Role[] = ['format', 'pins', 'nails'];
const FILES: Readonly<Record<Role, string>> = { format: 'format.asc', pins: 'pins.asc', nails: 'nails.asc' };
/** Header lines before the first record, counted from the first non-blank line (ASCFile.cpp: 7+1, 7+1 and 6+1). */
const HEADER: Readonly<Record<Role, number>> = { format: 8, pins: 8, nails: 7 };

const baseName = (name: string) => (name.split(/[\\/]/).pop() ?? '').toLowerCase();
/** Identical whichever of the three files was chosen: the folder name when the path has one, otherwise the format file. */
function boardName(path: string): string {
  const folders = path.split(/[\\/]/); folders.pop();
  const folder = folders.pop()?.trim();
  return `${folder && !/^[A-Za-z]:$/.test(folder) ? folder : 'format'}.asc`;
}
/** NUL bytes in the first 8 KiB (outside BOM-marked UTF-16) mean binary data, which no ASC file is. */
function looksBinary(data: Uint8Array): boolean {
  if (data[0] === 0xff && data[1] === 0xfe || data[0] === 0xfe && data[1] === 0xff) return false;
  const nul = data.subarray(0, 8192).indexOf(0);
  if (nul < 0) return false;
  return !(nul > 0 && (data[nul - 1] === 10 || data[nul - 1] === 13) && data.subarray(nul).every(byte => byte === 0 || byte === 9 || byte === 10 || byte === 13 || byte === 32));
}

const DECIMAL_FIELD = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function recordStart(role: Role, text: string): boolean {
  const fields = text.split(/\s+/);
  if (role === 'format') return (fields.length === 2 || fields.length === 3) && DECIMAL_FIELD.test(fields[0]) && DECIMAL_FIELD.test(fields[1]) && (fields.length === 2 || DECIMAL_FIELD.test(fields[2]) || /^[A-Z]\d{1,6}$/.test(fields[2]));
  if (role === 'pins') return /^[Pp][Aa][Rr][Tt]\s+.+\s+\([TB]\)$/.test(text);
  return fields.length >= 8 && /^[^\d\s]\d+$/.test(fields[0]) && DECIMAL_FIELD.test(fields[1]) && DECIMAL_FIELD.test(fields[2]) && /^\([TB]\)$/.test(fields[5]);
}
interface Prepared { source: Source; rows: Row[]; blank: boolean; truncated: boolean; headerLines?: number }
function prepare(role: Role, data: Uint8Array, filename = FILES[role]): Prepared {
  const source: Source = { label: `ASC ${filename}`, format: ASC_FORMAT };
  const lines = splitLines(decodeText(data), source);
  const first = lines.findIndex(line => line.trim() !== '');
  if (first < 0) return { source, rows: [], blank: true, truncated: false };
  let start = first + HEADER[role];
  // Some exporters shorten their banner. A complete role-specific record is the delimiter,
  // rather than a guessed number of comment lines.
  for (let index = first; index < start && index < lines.length; index++) {
    if (recordStart(role, lines[index].trim())) { start = index; break; }
  }
  const physical = lines.length - (lines.at(-1) === '' ? 1 : 0);
  const rows: Row[] = [];
  for (let index = start; index < lines.length; index++) {
    const text = lines[index].trim();
    if (text) rows.push({ no: index + 1, text });
  }
  return { source, rows, blank: false, truncated: physical < start, headerLines: start - first };
}
/**
 * Whether the first record of the entry file has the layout of its role; the trio has no signature, so the layout is the
 * evidence. Only a nails.asc may legitimately hold no record (a board without test points); a header-only text file of
 * any other role is not evidence enough.
 */
function plausible(role: Role, file: Prepared): boolean {
  if (file.blank || file.truncated) return false;
  const [row] = file.rows;
  if (!row) return role === 'nails';
  try {
    if (role === 'format') readFormat([row], file.source, new Tally());
    else if (role === 'pins') { if (!/^Part\s/i.test(row.text)) return false; readPins([row], file.source, new Tally()); }
    else readNails([row], file.source, new Tally());
  } catch (error) {
    if (error instanceof BoardFormatError) return false;
    throw error;
  }
  return true;
}
/** Companion lookup by lowercase basename; keys may carry a path or any case. */
function companion(companions: ParseInput['companions'], filename: string): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const [key, bytes] of Object.entries(companions ?? {})) {
    if (baseName(key) !== filename) continue;
    if (!(bytes instanceof Uint8Array)) throw new BoardFormatError(`ASC: companion ${key} must be a byte array.`, 'INVALID_FORMAT', ASC_FORMAT);
    if (found && (found.length !== bytes.length || found.some((byte, index) => byte !== bytes[index]))) throw new BoardFormatError(`ASC: companion ${filename} is given twice with different contents.`, 'INVALID_FORMAT', ASC_FORMAT);
    found = bytes;
  }
  return found;
}

/**
 * format.asc (outline), pins.asc (components and pins) and nails.asc (test points) describe one board. The chosen file may
 * be any of the three; the other two come from `companions`, and the result does not depend on which one was chosen.
 * Recognition is by the file role (the trio has no magic number) plus the layout of the first record.
 */
export function parseAsc(input: ParseInput): Board | null {
  const entryName = baseName(input.name);
  const entry = entryName === '@format.asc' ? 'format' : ROLES.find(role => FILES[role] === entryName);
  if (!entry || looksBinary(input.data)) return null;
  const sourceNames = new Map<Role, string>([[entry, entryName]]);
  const prepared = new Map<Role, Prepared>([[entry, prepare(entry, input.data, entryName)]]);
  if (!plausible(entry, prepared.get(entry)!)) return null;
  const sources = new Map<Role, Uint8Array>([[entry, input.data]]);
  const missing: string[] = [];
  for (const role of ROLES) {
    if (role === entry) continue;
    let filename = FILES[role], bytes = companion(input.companions, filename);
    if (!bytes && role === 'format') { filename = '@format.asc'; bytes = companion(input.companions, filename); }
    if (bytes) { sources.set(role, bytes); sourceNames.set(role, filename); } else missing.push(FILES[role]);
  }
  if (missing.length) {
    throw new BoardFormatError(`ASC: the companion ${missing.length === 1 ? 'file' : 'files'} ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing.`, 'COMPANIONS_REQUIRED', ASC_FORMAT);
  }
  const tally = new Tally();
  const file = (role: Role): Prepared => {
    let result = prepared.get(role);
    if (!result) { result = prepare(role, sources.get(role)!, sourceNames.get(role)!); prepared.set(role, result); }
    if (result.truncated) reject(result.source, undefined, `the file is shorter than its ${HEADER[role]} header lines.`);
    if (result.headerLines !== undefined && result.headerLines < HEADER[role]) tally.extra.push(`ASC ${sourceNames.get(role)}: read a shortened header (${result.headerLines} of the usual ${HEADER[role]} lines).`);
    return result;
  };
  const pins = file('pins');
  if (!pins.rows.length) reject(pins.source, undefined, 'the file contains no component records.');
  const model: Model = { outline: readFormat(file('format').rows, file('format').source, tally), parts: readPins(pins.rows, pins.source, tally, true), nails: readNails(file('nails').rows, file('nails').source, tally) };
  const board = assemble({ ...input, name: boardName(input.name) }, { label: 'ASC', format: ASC_FORMAT }, model, tally);
  if (pins.headerLines! < HEADER.pins || prepared.get('nails')!.headerLines! < HEADER.nails) board.legacyPositionalNotesUnsafe = true;
  return board;
}
