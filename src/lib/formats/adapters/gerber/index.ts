import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { GERBER_FORMAT, GERBER_SECOND, GERBER_UNITS, refuseFamily } from '../../recognizers';
import { hasNul, isComplete, latin1 } from '../../sniff';

export default defineBoardAdapter({
  capability: {
    id: 'gerber', name: 'Gerber RS-274X', extensions: ['.gbr'], variants: ['single-layer RS-274X graphics'], status: 'recognized-unsupported', validation: 'none', electrical: 'none', geometry: 'real',
    units: 'MO IN/MM', sides: 'n/a', notes: ['A single Gerber layer has no components or nets; a geometry-only mode would be needed.'],
  },
  listOrder: 180,
  family: 'Gerber',
  detection: 'structure',
  // recognizers.ts: a %FS format statement plus a second marker in the head or in the last 512 bytes (M02* closes the file).
  sniff(input) {
    if (hasNul(input.head, 1024)) return NO_MATCH;
    const head = latin1(input.head);
    if (!GERBER_FORMAT.test(head)) return NO_MATCH;
    const units = GERBER_UNITS.exec(head)?.[1];
    if (GERBER_SECOND.test(head)) return sniffed(48, '%FS format statement and a second RS-274X marker', units ? { meta: { units: units === 'MM' ? 'mm' : 'inch' } } : {});
    return isComplete(input) ? NO_MATCH : sniffed(20, '%FS format statement; the second marker may be in the tail');
  },
  parse: refuseFamily('gerber'),
});
