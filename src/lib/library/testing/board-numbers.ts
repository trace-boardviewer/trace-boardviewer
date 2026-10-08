/*
 * Board-number shapes of the Library design, with random digits. Only the SHAPES follow the design table; every number is
 * drawn at random, so none is a real board number. Revision schemes follow the same table (letters, R1.0, REV1.1, build stages).
 */
import type { Rng } from './rng.ts';

export type BoardNumberShapeId =
  | 'logic-board-820' | 'schematic-051' | 'la-code' | 'nm-code' | 'da0-code' | 'dotted-48' | '6050a' | 'ms-code' | 'ba41' | 'gpu-109' | 'cn-code' | 'model-sm' | 'model-a4' | 'generic-mb';

export interface BoardNumberShape {
  id: BoardNumberShapeId;
  /** Informal shape as in the design table. */
  pattern: string;
  /** Pick weight for a family's own board number (0: used only as a secondary document number). */
  weight: number;
  make(rng: Rng): string;
}

const firstDigit = (rng: Rng): string => String(rng.int(1, 9));

export const BOARD_NUMBER_SHAPES: readonly BoardNumberShape[] = [
  { id: 'logic-board-820', pattern: '820-ddddd[-X]', weight: 10, make: rng => `820-${rng.digits(5)}` },
  { id: 'schematic-051', pattern: '051-dddd(d)', weight: 0, make: rng => `051-${rng.digits(rng.chance(0.4) ? 5 : 4)}` },
  { id: 'la-code', pattern: 'LA-XXXX[P]', weight: 14, make: rng => `LA-${rng.letters(1)}${rng.digits(3)}${rng.chance(0.6) ? 'P' : ''}` },
  { id: 'nm-code', pattern: 'NM-Xddd', weight: 10, make: rng => `NM-${rng.letters(1)}${rng.digits(3)}` },
  { id: 'da0-code', pattern: 'DA0XXXXXMBXXX', weight: 10, make: rng => `DA0${rng.alnum(3)}MB${rng.digits(1)}${rng.letters(1)}${rng.digits(1)}` },
  { id: 'dotted-48', pattern: 'dd(d).XXXXX.XXX(X)', weight: 8, make: rng => `${rng.digits(2)}.${rng.digits(1)}${rng.letters(2)}${rng.digits(2)}.${rng.digits(3)}${rng.chance(0.2) ? rng.letters(1) : ''}` },
  { id: '6050a', pattern: '6050Addddddd', weight: 8, make: rng => `6050A${firstDigit(rng)}${rng.digits(6)}` },
  { id: 'ms-code', pattern: 'MS-dddd(d)', weight: 5, make: rng => (rng.chance(0.5) ? `MS-${firstDigit(rng)}${rng.digits(rng.chance(0.5) ? 3 : 4)}` : `MS-${rng.digits(2)}${rng.letters(1)}${rng.digits(1)}`) },
  { id: 'ba41', pattern: 'BA41-dddddX', weight: 8, make: rng => `BA41-${rng.digits(5)}${rng.letters(1)}` },
  { id: 'gpu-109', pattern: '109-Xddddd-dd', weight: 5, make: rng => `109-${rng.letters(1)}${rng.digits(5)}-${rng.digits(2)}` },
  { id: 'cn-code', pattern: 'CN-0XXXXX', weight: 5, make: rng => `CN-0${rng.letters(2)}${rng.digits(3)}` },
  { id: 'model-sm', pattern: 'SM-XdddX(X)', weight: 5, make: rng => `SM-${rng.letters(1)}${rng.digits(3)}${rng.letters(rng.chance(0.3) ? 2 : 1)}` },
  { id: 'model-a4', pattern: 'Adddd', weight: 3, make: rng => `A${firstDigit(rng)}${rng.digits(3)}` },
  { id: 'generic-mb', pattern: 'MB-XXXX', weight: 3, make: rng => `MB-${rng.letters(2)}${rng.digits(2)}` },
];

const BY_ID = new Map(BOARD_NUMBER_SHAPES.map(shape => [shape.id, shape] as const));
export const makeNumberOfShape = (id: BoardNumberShapeId, rng: Rng): string => BY_ID.get(id)!.make(rng);
export const pickBoardNumberShape = (rng: Rng): BoardNumberShapeId => rng.weighted(BOARD_NUMBER_SHAPES.filter(shape => shape.weight > 0).map(shape => [shape.id, shape.weight] as const));

/** The same shape with one or two characters of the same class changed: a different board whose number is easy to mistake. */
export function nearMissNumber(number: string, rng: Rng): string {
  const positions: number[] = [];
  for (let i = 0; i < number.length; i++) if (/[0-9A-Z]/.test(number[i]) && i >= 3) positions.push(i);
  if (!positions.length) return number + '1';
  let out = number;
  for (const at of rng.sample(positions, rng.int(1, 2))) {
    const ch = out[at];
    const next = /[0-9]/.test(ch) ? String((Number(ch) + rng.int(1, 8)) % 10) : rng.letters(1);
    out = out.slice(0, at) + (next === ch ? (/[0-9]/.test(ch) ? String((Number(ch) + 1) % 10) : (ch === 'A' ? 'B' : 'A')) : next) + out.slice(at + 1);
  }
  return out === number ? number + '1' : out;
}

export type RevisionScheme = 'letter' | 'dotted' | 'rev-number' | 'stage';
export const REVISION_SCHEMES: readonly RevisionScheme[] = ['letter', 'dotted', 'rev-number', 'stage'];

/** Revision labels of a family, oldest first. */
export function revisionLabels(scheme: RevisionScheme, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (scheme === 'letter') out.push(String.fromCharCode(65 + i));
    else if (scheme === 'dotted') out.push(`R${1 + (i >> 1)}.${i & 1}`);
    else if (scheme === 'rev-number') out.push(`REV${1 + i}.0`);
    else out.push(['EVT', 'DVT', 'PVT', 'MP'][i] ?? `MP${i - 2}`);
  }
  return out;
}

/** Ways a revision is written into a file name or a title; `number` is the family's board number. */
export function revisionText(label: string, scheme: RevisionScheme, rng: Rng): string {
  if (scheme === 'letter') return rng.pick([`rev ${label}`, `REV ${label}`, `rev${label}`, `_${label}`, `-${label}`, `Rev.${label}`]);
  if (scheme === 'stage') return label;
  return rng.pick([label, label.toLowerCase(), `v${label.replace(/^R(EV)?/, '')}`]);
}
