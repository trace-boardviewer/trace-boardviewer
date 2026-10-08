import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseFabmaster, sniffFabmaster } from '../../fabmaster';
import { mayContinueAsText } from '../../sniff';
export default defineBoardAdapter({
 capability: { id: 'fabmaster', name: 'Fabmaster (FATF)', extensions: ['.fab', '.fatf'], variants: ['Fabmaster (FATF) text records'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'mixed', units: 'J unit rows: mil, mm, micron, inch, cm', sides: 'SYM_MIRROR selects bottom; through-hole pads both', notes: ['No vendor-written file validated. Padstack offsets are ignored; pad rotations and first-copper sizes are unverified; custom pads use bounding rectangles.'] },
 listOrder: 210, family: 'ECAD design', detection: 'structure',
 sniff(input) {
  const found = sniffFabmaster(input.head);
  const owns = ['.fab', '.fatf'].some(extension => input.name.toLowerCase().endsWith(extension));
  if (found.confidence >= 0.7 || owns && found.confidence >= 0.5) return sniffed(Math.min(89, Math.round(found.confidence * 100)), found.reason);
  if (mayContinueAsText(input)) return sniffed(2, 'Text records may continue beyond the head');
  return NO_MATCH;
 },
 parse: parseFabmaster,
});
