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
  return data.subarray(0, 8192).includes(0);
}

interface Prepared { source: Source; rows: Row[]; blank: boolean; truncated: boolean }
function prepare(role: Role, data: Uint8Array): Prepared {
  const source: Source = { label: `ASC ${FILES[role]}`, format: ASC_FORMAT };
  const lines = splitLines(decodeText(data), source);
  const first = lines.findIndex(line => line.trim() !== '');
  if (first < 0) return { source, rows: [], blank: true, truncated: false };
  const start = first + HEADER[role];
  const physical = lines.length - (lines.at(-1) === '' ? 1 : 0);
  const rows: Row[] = [];
  for (let index = start; index < lines.length; index++) {
    const text = lines[index].trim();
    if (text) rows.push({ no: index + 1, text });
  }
  return { source, rows, blank: false, truncated: physical < start };
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
    if (role === 'format') readFormat([row], file.source);
    else if (role === 'pins') { if (!/^Part\s/.test(row.text)) return false; readPins([row], file.source, new Tally()); }
    else readNails([row], file.source, new Tally());
  } catch (error) {
    if (error instanceof BoardFormatError) return false;
    throw error;
  }
  return true;
}
/** Companion lookup by lowercase basename; keys may carry a path or any case. */
function companion(companions: ParseInput['companions'], role: Role): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const [key, bytes] of Object.entries(companions ?? {})) {
    if (baseName(key) !== FILES[role]) continue;
    if (!(bytes instanceof Uint8Array)) throw new BoardFormatError(`ASC: companion ${key} must be a byte array.`, 'INVALID_FORMAT', ASC_FORMAT);
    if (found && (found.length !== bytes.length || found.some((byte, index) => byte !== bytes[index]))) throw new BoardFormatError(`ASC: companion ${FILES[role]} is given twice with different contents.`, 'INVALID_FORMAT', ASC_FORMAT);
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
  const entry = ROLES.find(role => FILES[role] === baseName(input.name));
  if (!entry || looksBinary(input.data)) return null;
  const prepared = new Map<Role, Prepared>([[entry, prepare(entry, input.data)]]);
  if (!plausible(entry, prepared.get(entry)!)) return null;
  const sources = new Map<Role, Uint8Array>([[entry, input.data]]);
  const missing: string[] = [];
  for (const role of ROLES) {
    if (role === entry) continue;
    const bytes = companion(input.companions, role);
    if (bytes) sources.set(role, bytes); else missing.push(FILES[role]);
  }
  if (missing.length) {
    throw new BoardFormatError(`ASC: the companion ${missing.length === 1 ? 'file' : 'files'} ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing.`, 'COMPANIONS_REQUIRED', ASC_FORMAT);
  }
  const file = (role: Role): Prepared => {
    let result = prepared.get(role);
    if (!result) { result = prepare(role, sources.get(role)!); prepared.set(role, result); }
    if (result.truncated) reject(result.source, undefined, `the file is shorter than its ${HEADER[role]} header lines.`);
    return result;
  };
  const tally = new Tally();
  const pins = file('pins');
  if (!pins.rows.length) reject(pins.source, undefined, 'the file contains no component records.');
  const model: Model = { outline: readFormat(file('format').rows, file('format').source), parts: readPins(pins.rows, pins.source, tally), nails: readNails(file('nails').rows, file('nails').source, tally) };
  return assemble({ ...input, name: boardName(input.name) }, { label: 'ASC', format: ASC_FORMAT }, model, tally);
}
