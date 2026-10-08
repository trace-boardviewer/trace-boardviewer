import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseBvr } from '../../bvr';
import { hasUtf16Mark, mayContinueAsText } from '../../sniff';
import { bvrHeader } from './header';
import { bvrHook } from '../../../diagnostics/hooks-text';

export default defineBoardAdapter({
  capability: {
    id: 'bvr', name: 'BVR raw boardview (BVRAW_FORMAT_3)', extensions: ['.bvr'], variants: ['BVRAW_FORMAT_3 (PART_/PIN_ records with radii)'], status: 'supported', validation: 'real-files',
    electrical: 'nets', geometry: 'mixed',
    units: 'mil (×0.0254)', sides: 'PART_SIDE/PIN_SIDE T/B/O (absent = both, disclosed); coordinates are the same for both sides (no mirroring)',
    notes: ['Also validated with open tool-written files: the five Raspberry Pi Pico boardviews (open design) exported by the open-source kicad-boardview plugin. All five open; three were cross-checked against their .kicad_pcb: components, pin counts per component, net names, sides and pin positions agree to the file\'s 1 mil resolution; the exporter leaves out non-copper and overlapping same-numbered pads.', 'PIN_NUMBER, PIN_NAME and PIN_NET may be empty (fiducials, unconnected pads); a net name may contain blanks. PIN_RADIUS is half the pad\'s larger dimension in mil in these exports.', 'Positioned components without pins are retained when this export omits PART_END at the next component; incomplete pin blocks are rejected. The .obdata metadata sidecars (package, value and status per reference) are not read.', 'Other BVRAW_FORMAT_<n> versions are recognized and rejected as unsupported variants.', '.bv Jet databases use the separate bounded BV reader; unsupported database engines or schemas require a readable export.'],
  },
  evidence: { status: 'validated with selected real files and open designs', validatedWith: 'selected BVRAW_FORMAT_3 exports; canonical geometry, sides, component links and net membership checked, in addition to the Pico cross-checks', rewrites: [], extra: ['Positioned pinless component terminators have synthetic regressions. No private sample is distributed.'] },
  listOrder: 50,
  family: 'Boardview',
  detection: 'signature',
  // bvr.ts reads the first BVRAW_FORMAT_<n> line anywhere in the file; version 1 is the BVR1 adapter's, every other version is
  // refused here as an unsupported variant. The header is certain on the first line, where every BVR file has it, and likely
  // further down; a header beyond the window stays possible (parseBvr reads both dialects).
  sniff(input) {
    if (hasUtf16Mark(input.head)) return NO_MATCH;
    const header = bvrHeader(input);
    if (typeof header === 'object' && header.version !== 1) {
      const variant = `BVRAW_FORMAT_${header.version}`, unsupported = header.version === 3 ? '' : ' (unsupported version)';
      return sniffed(header.firstLine ? (header.version === 3 ? 100 : 95) : 83, `${variant} header ${header.firstLine ? 'on the first line' : 'line'}${unsupported}`, { variant, meta: { version: header.version } });
    }
    if (header === 'open' || header === undefined && mayContinueAsText(input)) return sniffed(7, 'a BVRAW_FORMAT header may lie beyond the sniff window');
    return NO_MATCH;
  },
  structure: bvrHook,
  parse: parseBvr,
});
