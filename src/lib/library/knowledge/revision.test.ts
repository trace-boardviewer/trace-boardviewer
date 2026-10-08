import { describe, expect, it } from 'vitest';
import { bestRevision, compareRevisions, parseRevisions, revisionKey, type RevisionScheme } from './revision';

const first = (text: string) => parseRevisions(text)[0];

describe('revisions: a label word and a letter', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const forms: Array<[string, (letter: string) => string]> = [
    ['REV x', letter => `REV ${letter}`], ['Rev.x', letter => `Rev.${letter}`], ['REV_x', letter => `REV_${letter}`], ['REV-x', letter => `REV-${letter}`],
    ['Revision x', letter => `Revision ${letter}`], ['REVx', letter => `REV${letter}`], ['rev: x', letter => `rev: ${letter.toLowerCase()}`],
  ];
  const cases: Array<[string, string, string]> = [];
  for (const [formName, make] of forms) for (const letter of letters) cases.push([`${formName} with ${letter}`, make(letter), letter]);
  it('has at least one hundred and eighty written forms', () => {
    expect(cases.length).toBeGreaterThanOrEqual(180);
  });
  it.each(cases)('%s', (_title, text, letter) => {
    const found = parseRevisions(text);
    expect(found).toHaveLength(1);
    expect(found[0].normalized).toBe(letter);
    expect(found[0].scheme).toBe('letter');
    expect(found[0].rank).toEqual([letter.charCodeAt(0) - 64]);
    expect(text.slice(found[0].start, found[0].end).toUpperCase().replace(/[^A-Z]/g, '').endsWith(letter)).toBe(true);
  });
});

describe('revisions: numbers, dotted numbers and letters with digits', () => {
  const rows: Array<[string, string, RevisionScheme]> = [
    ['REV 1', '1', 'number'], ['REV 2', '2', 'number'], ['REV 3', '3', 'number'], ['REV 9', '9', 'number'], ['REV 10', '10', 'number'], ['REV 12', '12', 'number'], ['REV 120', '120', 'number'],
    ['Rev.1', '1', 'number'], ['Rev.2', '2', 'number'], ['Rev_3', '3', 'number'], ['REV-4', '4', 'number'], ['REV: 5', '5', 'number'], ['REV 01', '1', 'number'], ['REV 02', '2', 'number'],
    ['REV 007', '7', 'number'], ['REV_08', '8', 'number'], ['REV-09', '9', 'number'], ['REV1', '1', 'number'], ['REV02', '2', 'number'], ['REV10', '10', 'number'],
    ['REV 1.0', '1.0', 'number'], ['REV 1.1', '1.1', 'number'], ['REV 2.0', '2.0', 'number'], ['REV 2.5', '2.5', 'number'], ['REV 10.2', '10.2', 'number'], ['REV 1.00', '1.0', 'number'],
    ['REV 1.10', '1.10', 'number'], ['REV 2.1.3', '2.1.3', 'number'], ['REV 0.9', '0.9', 'number'], ['Revision 1.0', '1.0', 'number'], ['REV1.0', '1.0', 'number'], ['REV1.2', '1.2', 'number'],
    ['REV_1.0', '1.0', 'number'], ['REV-2.1', '2.1', 'number'], ['rev 3.4', '3.4', 'number'],
    ['R1.0', '1.0', 'number'], ['R2.1', '2.1', 'number'], ['R10.5', '10.5', 'number'], ['r1.0', '1.0', 'number'], ['R3.14', '3.14', 'number'], ['R0.9', '0.9', 'number'],
    ['REV A1', 'A1', 'alnum'], ['REV A01', 'A1', 'alnum'], ['REV B02', 'B2', 'alnum'], ['REV X01', 'X1', 'alnum'], ['REV C10', 'C10', 'alnum'], ['REV P1', 'P1', 'alnum'], ['REV T2', 'T2', 'alnum'],
    ['REVA01', 'A1', 'alnum'], ['REVB2', 'B2', 'alnum'], ['Rev.AB', 'AB', 'letter'], ['REV AB', 'AB', 'letter'], ['REV BA', 'BA', 'letter'], ['REV ZZ', 'ZZ', 'letter'],
  ];
  it.each(rows)('%j reads as %s (%s)', (text, normalized, scheme) => {
    const found = parseRevisions(text);
    expect(found.map(match => [match.normalized, match.scheme])).toEqual([[normalized, scheme]]);
  });
});

describe('revisions: build stages and versions', () => {
  const rows: Array<[string, string, RevisionScheme]> = [];
  for (const stage of ['EVT', 'DVT', 'PVT', 'FVT']) {
    rows.push([stage, stage, 'stage'], [stage.toLowerCase(), stage, 'stage']);
    for (const number of ['1', '2', '3', '10']) rows.push([`${stage}${number}`, `${stage}${number}`, 'stage']);
    rows.push([`${stage}-1`, `${stage}1`, 'stage'], [`${stage} 2`, `${stage}2`, 'stage'], [`${stage}_3`, `${stage}3`, 'stage'], [`${stage}0`, `${stage}0`, 'stage']);
  }
  rows.push(['MP', 'MP', 'stage'], ['mp', 'MP', 'stage'], ['Board MP final', 'MP', 'stage']);
  rows.push(['v2.5', 'V2.5', 'version'], ['V2.5', 'V2.5', 'version'], ['V1', 'V1', 'version'], ['v1.0', 'V1.0', 'version'], ['V10.2.1', 'V10.2.1', 'version'], ['v12', 'V12', 'version'], ['v1.05', 'V1.5', 'version']);
  rows.push(['ver 3', 'V3', 'version'], ['VER 3.1', 'V3.1', 'version'], ['VERSION 1.2', 'V1.2', 'version'], ['Version: 2', 'V2', 'version'], ['ver. 4.0', 'V4.0', 'version']);
  it('has stage and version forms', () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
  });
  it.each(rows)('%j reads as %s (%s)', (text, normalized, scheme) => {
    const found = parseRevisions(text);
    expect(found.map(match => [match.normalized, match.scheme])).toEqual([[normalized, scheme]]);
  });
  it('reads a stage word followed by a letter as the stage alone', () => {
    expect(parseRevisions('EVT-A').map(match => match.normalized)).toEqual(['EVT']);
  });
});

describe('revisions: after a board word and in a board number', () => {
  const rows: Array<[string, string, string]> = [
    ['MLB-A', 'A', 'board-word'], ['MB_B', 'B', 'board-word'], ['MAINBOARD C', 'C', 'board-word'], ['MOTHERBOARD-D', 'D', 'board-word'], ['mlb a', 'A', 'board-word'], ['MLB_E', 'E', 'board-word'],
    ['820-01234-A', 'A', 'board-number'], ['820-3115-B', 'B', 'board-number'], ['820-00875_C', 'C', 'board-number'], ['MacBook Pro 820-02016-D.brd', 'D', 'board-number'],
    ['6050A2999901-MB-A02', 'A2', 'board-number'], ['6050A2423701-MB-A01', 'A1', 'board-number'],
  ];
  it.each(rows)('%j gives %s from a %s', (text, normalized, basis) => {
    const found = parseRevisions(text);
    expect(found.map(match => [match.normalized, match.basis])).toEqual([[normalized, basis]]);
  });
  it('does not take the revision of a number that the scope does not read', () => {
    expect(parseRevisions('MS-17Z9-A', { scope: 'name' })).toEqual([]);
  });
});

describe('revisions: text that is not a revision', () => {
  const negatives = [
    'R1', 'R12', 'R100', 'R1234', 'REVIEW', 'REVERSE', 'REVENUE', 'rev is', 'rev of', 'REV', 'REV.', 'REV 12345', 'REV ABC', 'REV a1b', 'preview 3', 'review A', 'V', 'VERY', 'VERIFY',
    'version', 'ver', 'MPEG', 'MP3', 'MP4', 'MLB', 'MB', 'MB-AB', 'MB-1', 'MLB-A1706', 'U7000', 'C5', 'V3V3', 'V1V', 'REVISIONS', 'REVOLUTION', 'REVERT', 'DVTX', 'EVT123', 'PVT1234',
    'R1_0', 'R.1', 'R1.', 'RR1.0', 'AR1.0', 'rev it', 'rev up', 'REV 1.', 'Revision', 'revised', 'Rev#', 'REV --- A', 'rev A.1', '', '   ', '---', '...', 'page 3', 'sheet B', 'MAINBOARD', 'MAINBOARD AB',
    '2024-10-07', 'version 2.5.1 beta', 'iPhone', 'TPS51225', 'LA-Z123P', 'Rev1A',
  ];
  it('has many negatives', () => {
    expect(negatives.length).toBeGreaterThanOrEqual(60);
  });
  it.each(negatives)('%j gives no revision', text => {
    const found = parseRevisions(text);
    // A few of these contain a real revision word by design; the rest give nothing.
    const allowed: Record<string, string[]> = { 'version 2.5.1 beta': ['V2.5.1'], 'REV a1b': [], 'rev A.1': ['A'], 'R1.': [], 'REV 1.': ['1'], 'EVT123': [], 'Rev1A': [] };
    expect(found.map(match => match.normalized)).toEqual(allowed[text] ?? []);
  });
  it('gives an empty array for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], Symbol('x')] as unknown[]) expect(parseRevisions(value as string)).toEqual([]);
  });
});

describe('revisions: several in one text', () => {
  it('returns them in text order with their spans', () => {
    const text = 'Board REV B, layout R2.1, EVT2 and v3.0';
    const found = parseRevisions(text);
    expect(found.map(match => match.normalized)).toEqual(['B', '2.1', 'EVT2', 'V3.0']);
    expect(found.map(match => text.slice(match.start, match.end))).toEqual(['REV B', 'R2.1', 'EVT2', 'v3.0']);
  });
  it('reads the revision of a board number and a label separately', () => {
    const found = parseRevisions('820-01234-A REV B');
    expect(found.map(match => [match.normalized, match.basis])).toEqual([['A', 'board-number'], ['B', 'label']]);
  });
  it('picks the most confident revision', () => {
    const found = parseRevisions('MLB-A v2 REV C');
    expect(bestRevision(found)?.normalized).toBe('C');
    expect(bestRevision([])).toBeUndefined();
  });
  it('rates label forms above guesses', () => {
    expect(first('REV A').confidence).toBe(90);
    expect(first('REVA').confidence).toBe(80);
    expect(first('R1.0').confidence).toBe(70);
    expect(first('EVT2').confidence).toBe(80);
    expect(first('MP').confidence).toBe(50);
    expect(first('v2.5').confidence).toBe(60);
    expect(first('V1').confidence).toBe(40);
    expect(first('MLB-A').confidence).toBe(55);
    expect(first('ver 3').confidence).toBe(70);
    expect(first('REV A01').confidence).toBe(85);
  });
  it('stops at the maximum number of results', () => {
    const text = Array.from({ length: 1000 }, () => 'REV A').join(' ');
    expect(parseRevisions(text).length).toBeLessThanOrEqual(256);
  });
});

describe('revisions: order within a scheme', () => {
  const rank = (text: string) => first(text);
  const rows: Array<[string, string, number | undefined]> = [
    ['REV A', 'REV B', -1], ['REV B', 'REV A', 1], ['REV A', 'REV A', 0], ['REV Z', 'REV AA', -1], ['REV AA', 'REV AB', -1], ['REV AB', 'REV Z', 1], ['REV C', 'REV D', -1], ['REV Y', 'REV Z', -1], ['REV M', 'REV N', -1],
    ['REV 1', 'REV 2', -1], ['REV 2', 'REV 10', -1], ['REV 10', 'REV 2', 1], ['REV 1', 'REV 1.0', 0], ['REV 1.0', 'REV 1.1', -1], ['REV 1.9', 'REV 1.10', -1], ['REV 1.10', 'REV 1.9', 1], ['REV 2.0', 'REV 1.9', 1],
    ['REV 01', 'REV 1', 0], ['REV 1.2.3', 'REV 1.2.4', -1], ['REV 1.2.3', 'REV 1.2', 1], ['REV 0.9', 'REV 1.0', -1], ['R1.0', 'REV 1.0', 0], ['R1.5', 'REV 2', -1],
    ['REV A1', 'REV A2', -1], ['REV A9', 'REV B1', -1], ['REV B1', 'REV A9', 1], ['REV A01', 'REV A1', 0], ['REV C10', 'REV C9', 1],
    ['EVT', 'DVT', -1], ['DVT', 'PVT', -1], ['PVT', 'MP', -1], ['EVT', 'MP', -1], ['EVT1', 'EVT2', -1], ['EVT2', 'DVT1', -1], ['DVT2', 'DVT10', -1], ['MP', 'EVT', 1], ['FVT', 'DVT', 1], ['FVT', 'PVT', -1],
    ['v1', 'v2', -1], ['v2.5', 'v2.10', -1], ['v3', 'v2.9', 1], ['v1.0', 'V1.0', 0],
    ['REV A', 'REV 1', undefined], ['REV A', 'EVT', undefined], ['REV 1', 'v1', undefined], ['REV A1', 'REV A', undefined], ['EVT', 'v1', undefined], ['REV AB', 'REV 12', undefined],
  ];
  it('has many comparisons', () => {
    expect(rows.length).toBeGreaterThanOrEqual(45);
  });
  it.each(rows)('%s against %s', (left, right, expected) => {
    expect(compareRevisions(rank(left), rank(right))).toBe(expected);
  });
  it('is antisymmetric and keeps one scheme apart from another', () => {
    const all = ['REV A', 'REV B', 'REV AA', 'REV 1', 'REV 2', 'REV 1.5', 'REV A1', 'REV B2', 'EVT1', 'DVT2', 'MP', 'v1', 'v2.5'].map(rank);
    for (const left of all) for (const right of all) {
      const forward = compareRevisions(left, right), backward = compareRevisions(right, left);
      if (forward === undefined) expect(backward).toBeUndefined();
      else expect(backward).toBe(-forward === 0 ? 0 : -forward);
    }
  });
  it('gives equal keys for equal revisions and different keys across schemes', () => {
    expect(revisionKey(rank('REV 02'))).toBe('number:2');
    expect(revisionKey(rank('REV 2'))).toBe('number:2');
    expect(revisionKey(rank('REV A'))).toBe('letter:A');
    expect(revisionKey(rank('REV A01'))).toBe('alnum:A1');
    expect(revisionKey(rank('EVT-2'))).toBe('stage:EVT2');
    expect(revisionKey(rank('v2.5'))).toBe('version:V2.5');
    expect(revisionKey(rank('REV 2'))).not.toBe(revisionKey(rank('v2')));
  });
});

describe('revisions: work is counted per character', () => {
  it('counts a bounded number of steps per character', () => {
    const meter = { steps: 0 };
    const text = 'MacBook REV B 820-00875-A R2.1 EVT2 v3.0 MLB-C '.repeat(60);
    parseRevisions(text, { meter });
    expect(meter.steps).toBeGreaterThan(0);
    expect(meter.steps).toBeLessThanOrEqual(30 * text.length);
  });
});
