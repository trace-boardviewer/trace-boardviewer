import { lines, type AdapterFixture } from '../../fixture';
import { zlibSync } from 'fflate';

// Decoded FZ content (the A!/S! records a container holds after decryption); no key and no vendor file is involved.
const FZ = ['UNIT:thou', 'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!', 'S!U1!!SOIC8!NO!0!', 'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!', 'S!GND!U1!1!VSS!1000!2000!!6!'];
const content = zlibSync(lines(FZ)), description = zlibSync(lines(['Original synthetic fixture', 'PARTNO\tDESCRIPTION\tQTY\tLOCATIONS\tPARTNO2']));
const u32 = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
const plain = Uint8Array.from([...u32(content.length), ...content, ...description, ...u32(description.length)]);
// Upstream derives the split from the footer, independently of the opaque leading word.
const footerFramed = Uint8Array.from([...u32(0), ...content, ...description, ...u32(description.length + 8)]);
const sized = Uint8Array.from([...u32(lines(FZ).length), ...content, ...u32(content.length + 8), ...u32(lines(['Original synthetic fixture', 'PARTNO\tDESCRIPTION\tQTY\tLOCATIONS\tPARTNO2']).length), ...description, ...u32(description.length + 8)]);

const fixtures: AdapterFixture[] = [
  { label: 'decoded FZ content', name: 'board.fz', data: lines(FZ) },
  { label: 'decoded CAE content', name: 'board.cae', data: lines(FZ, '\r\n') },
  { label: 'unencrypted FZ container', name: 'plain.fz', data: plain },
  { label: 'footer-framed CAE container with opaque leading word', name: 'footer.cae', data: footerFramed },
  { label: 'footer-framed FZ container with inflated-size metadata', name: 'sized.fz', data: sized },
];
export default fixtures;
