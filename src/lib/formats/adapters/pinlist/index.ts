import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parsePinList, sniffPinList } from '../../pinlist-csv';
import { mayContinueAsText } from '../../sniff';
export default defineBoardAdapter({
 capability: { id: 'pinlist', name: 'Pin list (CSV/TSV)', extensions: ['.csv', '.tsv', '.txt'], variants: ['Pin list (CSV/TSV) text records'], status: 'draft', validation: 'synthetic-fixtures', electrical: 'nets', geometry: 'estimated', units: 'Detected or explicitly supplied unit and decimal separator', sides: 'Detected side words or explicit default and side mapping', notes: ['Synthetic fixtures only. Familiar headers are detected; unfamiliar or headerless lists need explicit column, unit, decimal and side mapping. A mapping-confirmation interface is not yet available. No physical component bodies or outline.'] },
 listOrder: 230, family: 'ECAD design', detection: 'structure',
 sniff(input) {
  const found = sniffPinList(input.head);
  const owns = ['.csv', '.tsv', '.txt'].some(extension => input.name.toLowerCase().endsWith(extension));
  if (found.confidence >= 0.5 || owns && found.confidence >= 0.5) return sniffed(Math.min(89, Math.round(found.confidence * 100)), found.reason);
  if (mayContinueAsText(input)) return sniffed(2, 'Text records may continue beyond the head');
  return NO_MATCH;
 },
 parse: input => parsePinList(input, input.options?.pinList),
});
