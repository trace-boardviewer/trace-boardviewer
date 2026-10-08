import { defineBoardAdapter } from '../../adapter';
import { EASYEDA_STD_INFO, parseEasyedaStd } from '../../easyeda-std';
import { sniffReader } from './sniff';
export default defineBoardAdapter({
 capability: { ...EASYEDA_STD_INFO, extensions: [...EASYEDA_STD_INFO.extensions], variants: [...EASYEDA_STD_INFO.variants], notes: [...EASYEDA_STD_INFO.notes] },
 listOrder: 180, family: 'ECAD design', detection: 'structure',
 sniff: sniffReader, parse: parseEasyedaStd,
});
