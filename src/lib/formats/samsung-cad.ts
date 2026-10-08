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
 * trailing pin number after the dash (upstream discards it; it is used here as the pin number when present).
 */
import type { Board } from '../types';
import { BoardFormatError, decodeText, type ParseInput } from './common';
import { assemble, decimal, indexOfAscii, MAX_PARTS, MAX_PINS, reject, splitLines, Tally, type Model, type Nail, type PendingPart, type Source } from './bdv';

export const SAMSUNG_FORMAT = 'Samsung CAD';
const PANEL = '###Panel Added', PIN_KEYWORD = 'C_PIN';

/** CADFile::verifyFormat: both markers anywhere in the buffer. Checked on bytes so that other formats are never decoded just to be rejected. */
export function looksLikeSamsungCad(data: Uint8Array): boolean {
  if (data[0] === 0xff && data[1] === 0xfe || data[0] === 0xfe && data[1] === 0xff) {
    try { const text = decodeText(data); return text.includes(PANEL) && text.includes(PIN_KEYWORD); }
    catch (error) { if (error instanceof BoardFormatError) throw error; return false; }
  }
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
  const nails: Nail[] = [];
  let pinCount = 0, otherSides = 0, viaOtherSides = 0, unscopedVias = 0, currentNet: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const row = lines[index].trim();
    if (!row) continue;
    const no = index + 1, fields = row.split(/\s+/);
    if (fields[0] === 'COMP') {
      if (fields.length < 8) reject(source, no, 'a COMP record needs type, name, part number, two unknown fields, X, Y and side.');
      if (parts.length >= MAX_PARTS) reject(source, no, 'component count exceeds the import limit.', 'LIMIT_EXCEEDED');
      if (fields[7] !== '1' && fields[7] !== '2') otherSides++;
      const part: PendingPart = { ref: fields[1], side: fields[7] === '1' ? 'top' : 'bottom', pins: [] };
      parts.push(part); latest.set(part.ref, part); // CADFile.cpp: a later component of the same name takes over the name for the pins that follow
    } else if (fields[0] === PIN_KEYWORD) {
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
      owner.pins.push({ number: number || ordinal, ...(number ? {} : { numberGenerated: true }), name: number || ordinal, net: tally.net(netName(fields[8])), side: owner.side, x, y });
    } else if (fields[0] === 'NET') {
      currentNet = netName(fields[1]);
    } else if (fields[0] === 'N_VIA') {
      if (fields.length < 5) reject(source, no, 'an N_VIA record needs X, Y, an unknown field and side.');
      if (pinCount++ >= MAX_PINS) reject(source, no, 'pin and test point count exceeds the import limit.', 'LIMIT_EXCEEDED');
      const x = decimal(source, no, fields[1], 'test via X'), y = decimal(source, no, fields[2], 'test via Y');
      const side = decimal(source, no, fields[4], 'test via side');
      if (side !== 1 && side !== 2) viaOtherSides++;
      if (currentNet === undefined) unscopedVias++;
      // CADFile.cpp associates each via with the preceding NET record. Samsung carries no probe/pin id here:
      // the ordinal is only a display label, marked generated so it cannot become a notes identity.
      nails.push({ probe: `VIA:${nails.length + 1}`, generated: true, x, y, side: side === 1 ? 'top' : 'bottom', net: tally.net(currentNet ?? '') });
    }
  }
  if (!parts.length) reject(source, undefined, 'no COMP record was found.');
  // i18n: pending — English format notes, like the other boardview adapters.
  tally.extra.push('Samsung CAD: the format is not documented; coordinates are read as inches, like OpenBoardView.');
  if (otherSides) tally.extra.push(`${otherSides} ${otherSides === 1 ? 'component has' : 'components have'} a side code other than 1 or 2 and ${otherSides === 1 ? 'is' : 'are'} placed on the bottom side, as OpenBoardView does.`);
  if (viaOtherSides) tally.extra.push(`${viaOtherSides} ${viaOtherSides === 1 ? 'test via has' : 'test vias have'} a side code other than 1 or 2 and ${viaOtherSides === 1 ? 'is' : 'are'} placed on the bottom side, as OpenBoardView does.`);
  if (unscopedVias) tally.extra.push(`${unscopedVias} ${unscopedVias === 1 ? 'test via has' : 'test vias have'} no preceding NET record and ${unscopedVias === 1 ? 'is' : 'are'} shown without a net.`);
  const model: Model = { outline: [], parts, nails };
  return assemble(input, source, model, tally);
}
