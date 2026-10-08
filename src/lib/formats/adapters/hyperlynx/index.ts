import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseHyperlynx, sniffHyperlynx } from '../../hyperlynx';
import { mayContinueAsText } from '../../sniff';
export default defineBoardAdapter({
 capability: { id: 'hyperlynx', name: 'HyperLynx (.hyp)', extensions: ['.hyp'], variants: ['HyperLynx (.hyp) text records'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed', units: 'ENGLISH inch; METRIC cm, converted to mm', sides: 'SMD pads follow the padstack outer layer; through-hole pads both', notes: ['No vendor-written file validated; KiCad writes HyperLynx only from its GUI. Padstack geometry, angles and outline are proven on synthetic fixtures only.'] },
 listOrder: 200, family: 'ECAD design', detection: 'structure',
 sniff(input) {
  const found = sniffHyperlynx(input.head);
  const owns = ['.hyp'].some(extension => input.name.toLowerCase().endsWith(extension));
  if (found.confidence >= 0.8 || owns && found.confidence >= 0.5) return sniffed(Math.min(89, Math.round(found.confidence * 100)), found.reason);
  if (mayContinueAsText(input)) return sniffed(2, 'Text records may continue beyond the head');
  return NO_MATCH;
 },
 parse: parseHyperlynx,
});
