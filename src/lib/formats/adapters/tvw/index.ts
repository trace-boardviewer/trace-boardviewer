import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { hasTvwNetTable, isAppleDouble, parseTvw } from '../../tvw';

export default defineBoardAdapter({
  capability: {
    id: 'tvw', name: 'TVW boardview', extensions: ['.tvw'], variants: ['compact component metadata', 'component metadata with height word', 'two extra Pascal metadata fields', 'physical-pad UID references', 'separate top and bottom pin groups in one component', 'pin-list layer reference through the full layer-header list, including empty logical slots', 'named probe registries with declared origins, sizes and pack counts, with or without the usual 69-byte prefix', 'empty net-table entries and explicitly unconnected pads', 'zero round apertures and unexposed copper pads without exposed-area geometry'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'mixed',
    units: 'centimil (×0.000254 mm); disk Y/X coordinates are swapped', sides: 'each pin group names its layer by the zero-based index into the full layer-header list and the header type decides the side (1 TOP, 2 BOTTOM); empty logical slots and layers of other kinds count in that index; components with pins on both sides retain both; legacy numbers 2, 5 and 7 only resolve when no header occupies that index',
    notes: ['Original reader based on the MIT teboviewformat record description and independent byte inspection; no external TVW reader is included.', 'Every declared component and both of its pin groups are read sequentially. Each pin UID divided by eight indexes its declared physical-pad table, preserving its label, coordinates, net, side and dimensions; no nearby-pad or master-order guess is used.', 'Unnamed one-pin test-point records are imported with generated pin identity, including records with package names or an unknown classification. An unsupported record, invalid pad index, malformed table or resource-limit breach is rejected instead of silently dropping pins.', 'Board edges and copper traces are not imported. Custom pad shapes are represented by their bounding boxes. Real-file evidence covers the tested export variants and does not certify every TVW dialect.', 'Still refused: AppleDouble companion files, exports without a complete net table or a supported physical top/bottom layer, invalid physical coordinates, and pin lists that select a nonphysical or missing layer.'],
  },
  evidence: { status: 'validated with selected real files', validatedWith: 'checked by the maintainer on real exports: complete component tables and every pin UID link checked against the declared layer pads', rewrites: [], extra: ['All declared pins, including test points, are imported with exact source pad references. Symmetric bottom-footprint label swaps and reordered master pins are covered by regression tests. No sample is distributed.'] },
  listOrder: 170,
  family: 'Boardview',
  detection: 'structure',
  sniff(input) {
    // An AppleDouble stub ("._name") is no boardview; claiming it lets the reader refuse it with a clear message.
    if (isAppleDouble(input.head) && /(?:\.tvw|(?:^|[\\/])\._[^\\/]*)$/i.test(input.name)) return sniffed(60, 'AppleDouble companion file, not a boardview');
    if (hasTvwNetTable(input.head)) return sniffed(78, 'duplicate TVW net count and complete ProbeDB table terminator');
    return /\.tvw$/i.test(input.name) ? sniffed(40, '.tvw name; structured tables may lie beyond the sniff window') : NO_MATCH;
  },
  parse: parseTvw,
});
