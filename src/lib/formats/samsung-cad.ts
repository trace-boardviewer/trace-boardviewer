/*
 * Samsung CAD text boardview reader. The record layout (COMP / C_PIN / NET / N_VIA lines, field order, side code, the "###Panel Added"
 * and "C_PIN" detection) follows OpenBoardView's CADFile.cpp, read as a format reference (MIT, Copyright (c) 2016 Chloridite and
 * OpenBoardView contributors; see assets/licenses/openboardview-MIT.txt). The code below is original.
 *
 * What the reference reader knows, and therefore what this adapter reads:
 *   COMP  <type> <name> <part no.> <?> <?> <X> <Y> <side> <?>   side "1" is top, any other value bottom (X, Y are not used upstream either)
 *   C_PIN <type> <REF-PIN> <X> <Y> <?> <?> <?> <?> <net>        the part is the text before the first dash; coordinates are inches upstream
 *   NET   <type> <net name>                                      only names the vias that follow it upstream; no geometry is read from it
 *   N_VIA <type> <X> <Y> <?> <side> <?>                          test vias: upstream keeps them as nails (net information only)
 * Every other line (including the "###Panel Added" comment) is ignored, as upstream does. Pads carry no size, components have no body
 * and no outline: both come from the pins (upstream draws an outline 20 mil around the outermost pin).
 * Unverified: the unit (upstream multiplies by 1000 to reach mil, i.e. reads inches), the meaning of the unknown columns, and the
 * trailing pin number after the dash (upstream discards it; it is used here as the pin number when present). No vendor file was tested.
 */
import type { Board } from '../types';
import { decodeText, type ParseInput } from './common';
import { assemble, decimal, indexOfAscii, MAX_PARTS, MAX_PINS, reject, splitLines, Tally, type Model, type PendingPart, type Source } from './bdv';

export const SAMSUNG_FORMAT = 'Samsung CAD';
const PANEL = '###Panel Added', PIN_KEYWORD = 'C_PIN';

/** CADFile::verifyFormat: both markers anywhere in the buffer. Checked on bytes so that other formats are never decoded just to be rejected. */
export function looksLikeSamsungCad(data: Uint8Array): boolean {
  return indexOfAscii(data, PANEL) >= 0 && indexOfAscii(data, PIN_KEYWORD) >= 0;
}

/** CADFile.cpp strips one character from a net name that contains '/'; the intent is the leading "/" of a hierarchical name, so only that is removed. */
const netName = (token: string | undefined): string => (token ?? '').replace(/^\//, '');

export function parseSamsungCad(input: ParseInput): Board | null {
  if (!looksLikeSamsungCad(input.data)) return null;
  const source: Source = { label: 'Samsung CAD', format: SAMSUNG_FORMAT };
  const tally = new Tally();
  const lines = splitLines(decodeText(input.data), source);
  const parts: PendingPart[] = [], latest = new Map<string, PendingPart>();
  let pinCount = 0, vias = 0, otherSides = 0;
  for (let index = 0; index < lines.length; index++) {
    const row = lines[index].trim();
    if (!row) continue;
    const no = index + 1, fields = row.split(/\s+/);
    if (row.startsWith('COMP')) {
      if (fields.length < 8) reject(source, no, 'a COMP record needs type, name, part number, two unknown fields, X, Y and side.');
      if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      if (fields[7] !== '1' && fields[7] !== '2') otherSides++;
      const part: PendingPart = { ref: fields[1], side: fields[7] === '1' ? 'top' : 'bottom', pins: [] };
      parts.push(part); latest.set(part.ref, part); // CADFile.cpp: a later component of the same name takes over the name for the pins that follow
    } else if (row.startsWith(PIN_KEYWORD)) {
      if (fields.length < 8) reject(source, no, 'a C_PIN record needs type, component-pin, X, Y and four more fields (the net, last, may be absent).');
      if (pinCount++ >= MAX_PINS) reject(source, no, 'pin count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const x = decimal(source, no, fields[2], 'pin X'), y = decimal(source, no, fields[3], 'pin Y');
      // "REF-PIN": the longest known component name followed by a dash; a bare known name is a pin without a number.
      const token = fields[1];
      let owner = latest.get(token), number = '';
      for (let dash = token.lastIndexOf('-'); dash > 0 && !owner; dash = token.lastIndexOf('-', dash - 1)) {
        const candidate = latest.get(token.slice(0, dash));
        if (candidate) { owner = candidate; number = token.slice(dash + 1); }
      }
      if (!owner) reject(source, no, `a C_PIN record references the unknown component "${token.slice(0, 40)}".`);
      const ordinal = String(owner.pins.length + 1);
      owner.pins.push({ number: number || ordinal, name: number || ordinal, net: tally.net(netName(fields[8])), side: owner.side, x, y });
    } else if (row.startsWith('N_VIA')) {
      vias++;
    }
  }
  if (!parts.length) reject(source, undefined, 'no COMP record was found.');
  // i18n: pending — English format notes, like the other boardview adapters.
  tally.extra.push('Samsung CAD: the format is not documented; coordinates are read as inches, like OpenBoardView, and no vendor file was tested.');
  if (otherSides) tally.extra.push(`${otherSides} ${otherSides === 1 ? 'component has' : 'components have'} a side code other than 1 or 2 and ${otherSides === 1 ? 'is' : 'are'} placed on the bottom side, as OpenBoardView does.`);
  if (vias) tally.extra.push(`${vias} ${vias === 1 ? 'N_VIA record is' : 'N_VIA records are'} not shown: test vias carry no component or pin.`);
  const model: Model = { outline: [], parts, nails: [] };
  return assemble(input, source, model, tally);
}
