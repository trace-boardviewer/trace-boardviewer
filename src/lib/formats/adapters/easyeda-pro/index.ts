import { defineBoardAdapter } from '../../adapter';
import { EASYEDA_PRO_INFO, parseEasyedaPro } from '../../easyeda-pro';
import { sniffReader } from './sniff';
export default defineBoardAdapter({
 capability: { ...EASYEDA_PRO_INFO, extensions: [...EASYEDA_PRO_INFO.extensions], variants: [...EASYEDA_PRO_INFO.variants], notes: [...EASYEDA_PRO_INFO.notes] },
 listOrder: 190, family: 'ECAD design', detection: 'structure',
 sniff: sniffReader, parse: parseEasyedaPro,
});
