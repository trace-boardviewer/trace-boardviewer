/**
 * Board-number shapes: the table the board-number recogniser reads.
 *
 * Licence: CC0 1.0 (public domain dedication). The table describes the general SHAPE of the numbers printed on boards and
 * quoted in file names, folder names and schematic title blocks (a prefix, groups of digits and letters, separators). It is
 * written by the developers of this application from the public conventions of each maker; it contains no number from any
 * file, no catalogue and no private data of any maker. Every example is invented (made-up digits that follow the shape).
 *
 * A shape is a list of segments:
 *   lit / alt   a literal text, or one of several literal texts (compared after folding to upper case)
 *   D / A / X   a run of digits, letters or letters-and-digits with a length range, and optional demands on the run
 *   S           the separator "-"; with `loose` it also accepts "_" and, for the numeric Apple shapes, one blank
 *   dot         a "."
 *   opt         an optional group; when it is a `revision` group its text is reported as the revision and is not part of
 *               the normalised number
 * Segments of a shape never overlap in what they accept, so a shape is matched in one pass without backtracking.
 *
 * `confidence` is the pattern's own base confidence (0..100; high 80 and above, medium 55 to 79, low below 55). `scopes`
 * tells where the shape may be read: `all` (any text), `names-title` (file, folder and archive names, headers, outlines and
 * title blocks, not the running text of a document) or `names` (file, folder and archive names only). `provisional` shapes are
 * conventions that still need a confirming example from public documentation and a content-free calibration on a real collection (counts
 * per shape id only); they carry lower confidence on purpose.
 */
import type { DeviceType } from './lexicon';
import type { RecognitionScope } from './chars';

export type SegmentSpec =
  | { readonly t: 'lit'; readonly v: string }
  | { readonly t: 'alt'; readonly v: readonly string[] }
  | { readonly t: 'D' | 'A' | 'X'; readonly min: number; readonly max: number; readonly digits?: number; readonly letters?: number; readonly first?: 'D' | 'A' }
  | { readonly t: 'S'; readonly loose: 0 | 1 | 2 }
  | { readonly t: 'dot' }
  | { readonly t: 'opt'; readonly segs: readonly SegmentSpec[]; readonly revision: boolean };

export type ScopeGroup = 'all' | 'names-title' | 'names';

export interface BoardNumberShape {
  readonly id: string;
  readonly description: string;
  /** Vendor lexicon id the shape belongs to. */
  readonly vendor?: string;
  readonly device?: DeviceType;
  readonly confidence: number;
  readonly scopes: ScopeGroup;
  /** The number is only read when the same text also names a device (it collides with other things otherwise). */
  readonly needsDeviceWord?: boolean;
  readonly provisional?: boolean;
  /** What the number identifies in the Library model: a board number (the default) or a product model number. */
  readonly identifies?: 'board-number' | 'model';
  readonly segments: readonly SegmentSpec[];
  /** An invented example that the shape matches. */
  readonly example: string;
  /** What the example is normalised to. */
  readonly normalizedExample: string;
}

const lit = (v: string): SegmentSpec => ({ t: 'lit', v });
const alt = (...v: string[]): SegmentSpec => ({ t: 'alt', v });
const D = (min: number, max: number = min): SegmentSpec => ({ t: 'D', min, max });
const A = (min: number, max: number = min): SegmentSpec => ({ t: 'A', min, max });
const X = (min: number, max: number = min, need: { digits?: number; letters?: number; first?: 'D' | 'A' } = {}): SegmentSpec => ({ t: 'X', min, max, ...need });
const S = (loose: 0 | 1 | 2 = 0): SegmentSpec => ({ t: 'S', loose });
const dot = (): SegmentSpec => ({ t: 'dot' });
const opt = (...segs: SegmentSpec[]): SegmentSpec => ({ t: 'opt', segs, revision: false });
const rev = (...segs: SegmentSpec[]): SegmentSpec => ({ t: 'opt', segs, revision: true });

function shape(id: string, description: string, vendor: string | undefined, confidence: number, scopes: ScopeGroup, segments: SegmentSpec[], example: string, normalizedExample: string, extra: Partial<Pick<BoardNumberShape, 'device' | 'needsDeviceWord' | 'provisional' | 'identifies'>> = {}): BoardNumberShape {
  return { id, description, vendor, confidence, scopes, segments, example, normalizedExample, ...extra };
}

export const BOARD_NUMBER_SHAPES: readonly BoardNumberShape[] = [
  shape('logic-board-820', 'Apple logic board number (820-, four or five digits, optional revision letter)', 'apple', 85, 'all',
    [lit('820'), S(2), D(4, 5), rev(S(1), A(1))], '820-01234-A', '820-01234'),
  shape('schematic-051', 'Apple schematic number (051-, four or five digits); pairs with the 820 number through title blocks', 'apple', 80, 'names-title',
    [lit('051'), S(2), D(4, 5)], '051-9876', '051-9876'),
  shape('la-code', 'Compal board code (LA-, four characters, P)', 'compal', 85, 'all',
    [lit('LA'), S(1), X(4, 4, { digits: 1 }), lit('P')], 'LA-Z123P', 'LA-Z123P'),
  shape('la-code-nop', 'Compal board code without the trailing P (LA-, four characters with two or more digits)', 'compal', 60, 'names-title',
    [lit('LA'), S(1), X(4, 4, { digits: 2 })], 'LA-1234', 'LA-1234'),
  shape('nm-code', 'LCFC board code (NM-, one letter, three digits)', 'lcfc', 85, 'all',
    [lit('NM'), S(1), A(1), D(3)], 'NM-Z123', 'NM-Z123'),
  shape('da0-code', 'Quanta board code (DA0, three characters, MB, three characters)', 'quanta', 90, 'all',
    [lit('DA0'), X(3, 3), lit('MB'), X(3, 3, { digits: 1 })], 'DA0ZZ1MB6E0', 'DA0ZZ1MB6E0'),
  shape('da0-sub', 'Quanta sub-board code (DA0, three characters, two letters, three characters)', 'quanta', 60, 'all',
    [lit('DA0'), X(3, 3), A(2), X(3, 3, { digits: 1 })], 'DA0ZZ1HB6E0', 'DA0ZZ1HB6E0', { provisional: true }),
  shape('dotted-48', 'Wistron board code (two or three digits, dot, five characters, dot, three or four characters)', 'wistron', 60, 'all',
    [D(2, 3), dot(), X(5, 5, { first: 'D', letters: 1, digits: 2 }), dot(), X(3, 4, { digits: 1 })], '48.4ZZ01.011', '48.4ZZ01.011'),
  shape('inventec-6050a', 'Inventec board code (6050A and seven digits, optional -MB- revision)', 'inventec', 85, 'all',
    [lit('6050A'), D(7), rev(S(1), lit('MB'), S(1), X(3, 3, { first: 'A', digits: 2 }))], '6050A2999901-MB-A02', '6050A2999901'),
  shape('ms-code', 'MSI board code (MS-, four or five characters starting with a digit)', 'msi', 55, 'names-title',
    [lit('MS'), S(1), X(4, 5, { first: 'D', digits: 2 })], 'MS-17Z9', 'MS-17Z9'),
  shape('samsung-ba', 'Samsung assembly code for notebook boards (BA41, BA59, BA92 or BA94, five digits, optional letter)', 'samsung', 80, 'all',
    [alt('BA41', 'BA59', 'BA92', 'BA94'), S(2), D(5), opt(A(1))], 'BA41-01234A', 'BA41-01234A'),
  shape('samsung-bn', 'Samsung assembly code for television boards (BN41, BN44 or BN94, five digits, optional letter)', 'samsung', 70, 'all',
    [alt('BN41', 'BN44', 'BN94'), S(2), D(5), opt(A(1))], 'BN44-00123A', 'BN44-00123A', { device: 'monitor', provisional: true }),
  shape('amd-109', 'AMD graphics board number (109-, one letter, five digits, two digits)', 'amd', 70, 'all',
    [lit('109'), S(2), A(1), D(5), S(1), D(2)], '109-Z12345-00', '109-Z12345-00', { device: 'gpu' }),
  shape('nvidia-699', 'NVIDIA graphics board number (600- or 699-, digit letter three digits, four digits, three digits)', 'nvidia', 65, 'all',
    [alt('600', '699'), S(1), D(1), A(1), D(3), S(1), D(4), S(1), D(3)], '699-1Z123-0123-456', '699-1Z123-0123-456', { device: 'gpu', provisional: true }),
  shape('cn-dell', 'Dell part number with its country code (CN-0 and five characters)', 'dell', 55, 'names-title',
    [alt('CN', 'TW', 'MX', 'PH', 'MY', 'TH', 'BR'), S(1), lit('0'), X(5, 5, { digits: 1, letters: 1 })], 'CN-0ZZ123', 'CN-0ZZ123'),
  shape('model-sm', 'Samsung phone or tablet model (SM-, one letter, three digits, one or two characters)', 'samsung', 65, 'names-title',
    [lit('SM'), S(1), A(1), D(3), A(1), opt(X(1))], 'SM-Z999F', 'SM-Z999F', { identifies: 'model' }),
  shape('model-gt', 'Samsung phone model of the older series (GT-, one letter, four digits, optional letter)', 'samsung', 55, 'names-title',
    [lit('GT'), S(1), A(1), D(4), opt(A(1))], 'GT-Z9999', 'GT-Z9999', { provisional: true, identifies: 'model' }),
  shape('model-a4', 'Apple model number (A and four digits); collides with reference designators, so only in names and with a device word', 'apple', 40, 'names',
    [lit('A'), D(4)], 'A9999', 'A9999', { needsDeviceWord: true, identifies: 'model' }),
  shape('generic-mb', 'Generic main board label (MB, M/B or MAINBOARD with a code of four to eight characters)', undefined, 35, 'names',
    [alt('MAINBOARD', 'MB', 'M/B'), S(1), X(4, 8, { digits: 1, letters: 1 })], 'MB-ZQ12', 'MB-ZQ12'),
  shape('asus-60n', 'ASUS board code (60N, one letter, 0, three characters, MB, four digits)', 'asus', 65, 'all',
    [lit('60N'), A(1), lit('0'), X(3, 3), S(1), lit('MB'), D(4)], '60NB0ZZ0-MB1201', '60NB0ZZ0-MB1201', { provisional: true }),
  shape('lenovo-fru', 'Lenovo field-replaceable unit number (5B, two digits, one letter, five digits)', 'lenovo', 55, 'names-title',
    [lit('5B'), D(2), A(1), D(5)], '5B20Z12345', '5B20Z12345', { provisional: true }),
  shape('hp-spare', 'HP spare part number (one letter, five digits, dash, three digits)', 'hp', 50, 'names-title',
    [alt('J', 'K', 'L', 'M', 'N', 'P'), D(5), S(1), D(3)], 'L12345-601', 'L12345-601', { provisional: true }),
  shape('sony-console', 'Sony console model (CUH, CFI, CECH or SCPH, four digits, optional letters)', 'sony', 65, 'names-title',
    [alt('CUH', 'CFI', 'CECH', 'SCPH'), S(1), D(4), opt(A(1, 2))], 'CUH-1234A', 'CUH-1234A', { device: 'console', provisional: true, identifies: 'model' }),
];

/** Scope groups: which recognition scopes may read a shape. */
export function scopeAllows(group: ScopeGroup, scope: RecognitionScope): boolean {
  if (group === 'all') return true;
  if (group === 'names') return scope === 'name' || scope === 'folder' || scope === 'archive';
  return scope !== 'body';
}

export function boardNumberShape(id: string): BoardNumberShape | undefined {
  return BOARD_NUMBER_SHAPES.find(item => item.id === id);
}
