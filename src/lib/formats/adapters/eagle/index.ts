import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseEagle, prologWalk } from '../../eagle';
import { headText, hasUtf16Mark, isComplete, ruleHolds } from '../../sniff';
import { eagleHook } from '../../../diagnostics/hooks-text';

/** The root element is <eagle>, and (in a truncated head) its name is followed by another character, so it cannot be "<eagleX". */
const eagleRoot = (text: string, complete: boolean) => { const walk = prologWalk(text); return typeof walk === 'object' && walk.root === 'eagle' && (complete || walk.rootEnd < text.length); };
/** The head ends inside the prologue (or inside the root name), so the full file may still have an <eagle> root. */
const openProlog = (text: string) => { const walk = prologWalk(text); return walk === 'open' || typeof walk === 'object' && walk.rootEnd >= text.length && 'eagle'.startsWith(walk.root); };

export default defineBoardAdapter({
  capability: {
    id: 'eagle', name: 'EAGLE board XML', extensions: ['.brd'], variants: ['<eagle> board XML with <elements>, <libraries>, <signals> (declaration optional)'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'real',
    units: 'mm', sides: 'element rot M prefix mirrors to bottom; R angle rotates', notes: ['Original adapter from Autodesk ULP object documentation; no EAGLE code is used; fixtures are synthetic 9.6-style documents.', 'XML entities are never expanded (DOCTYPE ENTITY is rejected); EAGLE schematics (<schematic> root) are not boards and EAGLE libraries are rejected as the wrong kind.', 'Exact pads: SMD rectangle/square/fully round square and round or square through-hole pads; partially rounded, capsule (roundness 100 non-square), octagon, long and offset pads are drawn as bounding rectangles and counted as approximated. Only SMD layers 1 and 16 are supported.', 'The mirror order (x flips first, then counter-clockwise rotation) follows convention and is not independently verified. Outline arcs/circles are sampled as straight segments; inner loops are disclosed as cutouts; pad counts of referenced packages are preflighted against the 1,000,000-pin limit before any pin is created.'],
  },
  evidence: {
    status: 'validated with real files',
    validatedWith: 'real files: SparkFun RedBoard (EAGLE 7.7 XML board; 35 MB EAGLE 7.5 production panel); synthetic fixtures: 9.x documents, through-hole pads, rotated mirrored elements',
    rewrites: [
      { from: 'fixtures are synthetic 9.6-style documents.', to: 'fixtures are synthetic 9.6-style documents, and the real SparkFun RedBoard board and its 35 MB panel (EAGLE 7.7 and 7.5 XML) were validated as well.' },
      { from: 'The mirror order (x flips first, then counter-clockwise rotation) follows convention and is not independently verified.', to: 'Mirrored (bottom) elements were checked on real boards only without rotation (every signal wire that ends on a bottom pad lies on it); the order for an element that is mirrored AND rotated (x flips first, then counter-clockwise rotation) follows convention and is not independently verified.' },
    ],
    extra: [
      'Real-file result: element, pad, signal and contact counts and net names equal an independent reading of the files; signal wires and vias of the same signal end on their pads (2,576 checkable pads on the panel, rotations 0/90/180/270, bottom side included); the RedBoard outline is exactly 68.58 x 53.34 mm.',
      'No real file has a through-hole <pad> or a mirrored element with a rotation, so those paths stay synthetic-fixture only.',
      'Open gap, panels: a file with several boards keeps only the largest closed outline (the others are listed as cutouts) and the view bounds cover that one board, not the whole panel (963 of the 1,027 parts of the real 35 MB panel lie outside the kept bounds).',
      'A 35 MB panel of 1,027 parts opens in about 2.2 s (peak about 540 MB).',
    ],
  },
  listOrder: 120,
  family: 'ECAD design',
  detection: 'signature',
  // eagle.ts walks the XML prologue (declaration, comments, processing instructions, DOCTYPE) to the root element. An EAGLE
  // schematic or library also has the <eagle> root: parseEagle leaves a schematic unclaimed and refuses a library.
  sniff(input) {
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const complete = isComplete(input);
    const verdict = ruleHolds(input, text => eagleRoot(text, complete));
    if (verdict === 'all') {
      const text = headText(input), walk = prologWalk(text);
      const tag = typeof walk === 'object' ? text.slice(walk.rootEnd, walk.rootEnd + 512).split('>')[0] : '';
      const version = /\bversion\s*=\s*["']([0-9][0-9.]{0,15})["']/.exec(tag)?.[1];
      // A drawing holds a board, a schematic or a library. parseEagle leaves a schematic unclaimed with this very rule (a <schematic> element
      // and no <board>), so a head that already shows one is no evidence of a board: the root alone is only POSSIBLE and a listing calls the file a schematic.
      if (/<schematic[\s>]/.test(text) && !/<board[\s>]/.test(text)) return sniffed(20, '<eagle> root element of a schematic (a schematic is not a board)', version ? { meta: { version } } : {});
      return sniffed(100, '<eagle> root element', version ? { meta: { version } } : {});
    }
    if (verdict === 'some' || !complete && ruleHolds(input, openProlog) !== 'none') return sniffed(11, 'XML prologue that continues beyond the sniff window');
    return NO_MATCH;
  },
  structure: eagleHook,
  parse: parseEagle,
});
