import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseIpc2581, sniffIpc2581 } from '../../ipc2581';
export default defineBoardAdapter({
 capability: { id: 'ipc2581', name: 'IPC-2581', extensions: ['.xml', '.cvg'], variants: ['revision B/C XML; revision A read with B/C rules'], status: 'open-tool-validated', validation: 'open-tool-files', openTool: { tool: 'kicad-cli 9', designs: '27 open designs' }, electrical: 'nets', geometry: 'mixed', units: 'CadHeader units converted to mm', sides: 'Conductor layer side and component Xform mirror', notes: ['KiCad 9 exports only: 27 boards; 3,395/3,395 components and identical nets. Other writers are unverified.', 'One selected step is shown; revision A uses B/C rules. Shapes and curves may be approximated; copper tracks, zones and vias are not rendered. XML entities are refused.'] },
 listOrder: 300, family: 'ECAD design', detection: 'signature',
 sniff({ head }) { const found = sniffIpc2581(head); return found ? sniffed(Math.round(found.confidence * 100), 'IPC-2581 root element', { ...(found.revision ? { variant: found.revision, meta: { revision: found.revision } } : {}) }) : NO_MATCH; },
 parse: parseIpc2581,
});
