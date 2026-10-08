import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { hasTeboIctHeader, parseTeboIct } from '../../tebo-ict';
import { teboIctHook } from '../../tebo-ict-hook';

export default defineBoardAdapter({
  capability: { id: 'tebo-ict', name: 'Tebo ICT companion pair', extensions: ['.ict'], variants: ['!Tebo-ict v3.0 BOARD + BOARD_XY, scale 1 and inch units'], status: 'supported', validation: 'real-files', electrical: 'nets', geometry: 'estimated', units: 'explicit inch (×25.4)', sides: 'explicit TOP physical-pin access, otherwise HP3070 bottom access; explicit BOTTOM device declarations, other component sides derived from their pins', requires: ['companions'],
    notes: ['The validated source names are extensionless BOARD and BOARD_XY in one directory. BOARD.ict and BOARD_XY.ict are supported named aliases with synthetic coverage. Either role opens the same complete pair.', 'BOARD_XY supplies outline, physical pin identities, coordinates and access sides; BOARD CONNECTIONS supplies the nets. Both node tables and every physical/electrical Ref.Pin identity must match completely. NODE declarations never imply connectivity by position.', 'Only the validated OTHER ALTERNATES grammar is imported. Unknown units, scale, quoted identities, node-scoped alternatives, device outlines and probe flags are refused. Pads and component bodies use disclosed viewing estimates; values, packages, traces and probe availability are not imported. NO_PROBE and NO_ACCESS annotations retain electrical points.'],
  },
  evidence: { status: 'validated with a selected real pair', validatedWith: 'all four entry paths, two duplicate pairs containing one distinct geometry and one distinct electrical program; every physical point joined to its explicit connection', rewrites: [], extra: ['Identities, ownership, coordinates, units, sides, probe annotations, outline order and node tables checked independently. All committed fixtures are original synthetic text.'] },
  listOrder: 77, family: 'Boardview', detection: 'signature', companions: { sets: [['board', 'board_xy'], ['board.ict', 'board_xy.ict']] },
  sniff(input) { return hasTeboIctHeader(input.head) ? sniffed(95, '!Tebo-ict v3.0 header; a complete BOARD / BOARD_XY pair is required') : NO_MATCH; },
  structure: teboIctHook, parse: parseTeboIct,
});
