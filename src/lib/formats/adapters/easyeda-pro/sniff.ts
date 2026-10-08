import { NO_MATCH, sniffed, type SniffInput } from '../../adapter';
import { sniffEasyedaPro } from '../../easyeda-pro';
import { startsWith, isComplete } from '../../sniff';
export function sniffReader(input: SniffInput) {
 if (startsWith(input.head, [0x50, 0x4b, 3, 4])) {
  // Only local header names in the bounded head: no central-directory read or inflation.
  const names: string[] = [];
  for (let at = 0; at + 30 <= input.head.length; at++) {
   if (input.head[at] !== 0x50 || input.head[at+1] !== 0x4b || input.head[at+2] !== 3 || input.head[at+3] !== 4) continue;
   const length = input.head[at+26] | input.head[at+27] << 8;
   if (length && length <= 512 && at+30+length <= input.head.length) names.push(new TextDecoder().decode(input.head.subarray(at+30,at+30+length)).toLowerCase());
  }
  const pcb = names.some(name => /^pcb\/[^/]+\.epcb$/.test(name));
  if (names.includes('project.json') && pcb) return sniffed(95, 'ZIP local headers for project.json and PCB/*.epcb', { variant: 'epro-zip' });
  if (pcb) return sniffed(80, 'ZIP local header for PCB/*.epcb', { variant: 'epro-zip' });
  if (/\.epro$/i.test(input.name)) return sniffed(65, 'ZIP project named .epro; directory checked during parse');
  return sniffed(4, 'ZIP whose project members may follow the head');
 }
 const found = sniffEasyedaPro(input.head,input.name);
 if (found && found.kind !== 'schematic') return sniffed(Math.round(found.confidence*100), found.reason, { variant: found.variant });
 if (!isComplete(input) && new TextDecoder().decode(input.head).trimStart().startsWith('[')) return sniffed(3, 'JSON record header may follow the head');
 return NO_MATCH;
}
