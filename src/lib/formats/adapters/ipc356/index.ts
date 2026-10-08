import { defineBoardAdapter, NO_MATCH, sniffed } from '../../adapter';
import { parseIpc356, sniffIpc356 } from '../../ipc356';
import { mayContinueAsText } from '../../sniff';
export default defineBoardAdapter({
 capability: { id: 'ipc356', name: 'IPC-D-356', extensions: ['.ipc', '.356', '.d356', '.ipc356'], variants: ['IPC-D-356 text records'], status: 'open-tool-validated', validation: 'open-tool-files', openTool: { tool: 'kicad-cli 9', designs: '39 open designs' }, electrical: 'nets', geometry: 'estimated', units: 'CUST 0: 0.0001 inch; CUST 1 and SI supported synthetically', sides: 'Access codes select outer sides; bottom access can be overridden', notes: ['Electrical nets are exact; component bodies, outline and pad shapes are estimated. KiCad 9 exports: 39 files, 13,792 pads matched; only CUST 0 verified. Other writers and access conventions remain unverified.'] },
 listOrder: 220, family: 'ECAD design', detection: 'structure',
 sniff(input) {
  const found = sniffIpc356(input.head);
  const owns = ['.ipc', '.356', '.d356', '.ipc356'].some(extension => input.name.toLowerCase().endsWith(extension));
  if (found.confidence >= 0.5 || owns && found.confidence >= 0.5) return sniffed(Math.min(89, Math.round(found.confidence * 100)), found.reason);
  if (mayContinueAsText(input)) return sniffed(2, 'Text records may continue beyond the head');
  return NO_MATCH;
 },
 parse: input => parseIpc356(input, input.options?.ipc356),
});
