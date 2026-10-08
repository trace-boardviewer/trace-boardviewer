import { NO_MATCH, sniffed, type SniffInput } from '../../adapter';
import { sniffEasyedaStd } from '../../easyeda-std';
import { isComplete } from '../../sniff';
export function sniffReader(input: SniffInput) {
 const found = sniffEasyedaStd(input.head, input.name);
 if (found && found.kind !== 'schematic' && found.kind !== 'project') return sniffed(Math.round(found.confidence * 100), found.reason, { variant: found.variant });
 // An object header may continue past the bounded window.
 if (!isComplete(input) && new TextDecoder().decode(input.head).trimStart().startsWith('{')) return sniffed(5, 'JSON object whose PCB metadata may follow the head');
 return NO_MATCH;
}
