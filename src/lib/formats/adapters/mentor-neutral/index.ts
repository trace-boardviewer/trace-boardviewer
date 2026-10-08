import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { GENCAD_GUARD, mentorNeutral } from '../../recognizers';
import { parseMentorNeutral } from '../../mentor-neutral';
import { hasNul, latin1 } from '../../sniff';

export default defineBoardAdapter({
  capability: {
    id: 'mentor-neutral', name: 'Mentor Neutral', extensions: ['.neu', '.cad'], variants: ['Mentor Boardstation BOARD/B_UNITS/COMP/C_PIN records'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated',
    units: 'B_UNITS: Inches (×25.4), Mils (×0.0254), Mm (×1)', sides: 'COMP/C_PIN side 1 top, 2 bottom; layer-stack indices are not side codes', notes: ['Absolute C_PIN positions and nets, placed component origins and rotations are retained. Pad dimensions, traces, vias, mechanical additions and board outline are not inferred.', 'Nonzero board offset/orientation is recognized but unsupported. $NONE$ is disconnected; other net names, including a leading slash, retain their identity.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'selected neutral CAD contents, including designs first encountered in archives; declared units, explicit sides and absolute component/pin fields checked', rewrites: [], extra: ['Only the documented COMP/C_PIN subset is imported. Synthetic regressions cover units, literal net identity, malformed records and recovery of a missing NUL side from agreeing explicit pin sides. No sample is distributed.'] },
  listOrder: 150,
  family: 'ECAD design',
  // Two comment lines from one vendor help example are weak evidence: LIKELY at most, never certain.
  detection: 'structure',
  sniff({ head }) {
    const text = latin1(head);
    if (GENCAD_GUARD.test(text)) return NO_MATCH;
    if (/^BOARD\s+\S+\s+OFFSET\s+x:/m.test(text) && /^B_UNITS\s+/m.test(text)) return sniffed(85, 'Mentor BOARD offset and B_UNITS records');
    if (hasNul(head, 1024)) return NO_MATCH;
    return mentorNeutral(text) ? sniffed(45, '"# file :" and "# date :" comment header') : NO_MATCH;
  },
  parse: parseMentorNeutral,
});
