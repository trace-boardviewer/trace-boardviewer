import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { GENCAD_GUARD, mentorNeutral, refuseFamily } from '../../recognizers';
import { hasNul, latin1 } from '../../sniff';

export default defineBoardAdapter({
  capability: {
    id: 'mentor-neutral', name: 'Mentor Neutral', extensions: ['.neu'], variants: ['Mentor Graphics neutral file (# file / # date header)'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'estimated',
    units: 'unverified', sides: 'unverified', notes: ['Recognized by a header taken from a single vendor help example; no adapter or fixture.'],
  },
  listOrder: 150,
  family: 'ECAD design',
  // Two comment lines from one vendor help example are weak evidence: LIKELY at most, never certain.
  detection: 'structure',
  sniff({ head }) {
    if (hasNul(head, 1024)) return NO_MATCH;
    const text = latin1(head);
    return !GENCAD_GUARD.test(text) && mentorNeutral(text) ? sniffed(45, '"# file :" and "# date :" comment header') : NO_MATCH;
  },
  parse: refuseFamily('mentor-neutral'),
});
