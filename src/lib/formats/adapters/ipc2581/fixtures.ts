import { ipc2581Xml, canonicalBoard } from '../../ipc2581-fixtures';
import { utf8 } from '../../fixture';
export default [{ label: 'revision C board', name: 'board.xml', data: utf8(ipc2581Xml(canonicalBoard())) }];
