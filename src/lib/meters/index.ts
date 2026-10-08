/**
 * Meter link: the pure part. Decoders (bytes in, readings out), the simulated meter, the file bridge and the stability detector.
 * Transports (WebHID, Web Serial, Web Bluetooth, a polled file) and the device permission broker live elsewhere and use these.
 */
import { createBm86xDecoder, BM86X_INFO } from './brymen-bm86x';
import { createEs51922Decoder, ES51922_INFO } from './es51922';
import { createFileBridge, FILE_BRIDGE_INFO } from './file-bridge';
import { createFluke28xDecoder, FLUKE_28X_INFO } from './fluke-28x';
import { createOwonB35Decoder, OWON_B35_INFO } from './owon-b35';
import { SIMULATED_INFO } from './simulator';
import type { MeterDecoder, MeterFamilyId, MeterFamilyInfo } from './types';
import { createUt61EplusDecoder, UT61EPLUS_INFO } from './ut61eplus';

export * from './types';
export * from './stream';
export * from './es51922';
export * from './cp2110';
export * from './ut61eplus';
export * from './owon-b35';
export * from './fluke-28x';
export * from './brymen-bm86x';
export * from './file-bridge';
export * from './simulator';
export * from './stability';

/** What each family is, for the support table and the connect dialog. */
export const METER_FAMILIES: Readonly<Record<MeterFamilyId, MeterFamilyInfo>> = {
  ut61e: ES51922_INFO,
  ut61eplus: UT61EPLUS_INFO,
  'owon-b35': OWON_B35_INFO,
  'fluke-28x': FLUKE_28X_INFO,
  'brymen-bm86x': BM86X_INFO,
  'file-bridge': FILE_BRIDGE_INFO,
  simulated: SIMULATED_INFO,
};

/** Families that turn bytes into readings. */
export type DecoderFamilyId = Exclude<MeterFamilyId, 'simulated'>;

export function createMeterDecoder(family: DecoderFamilyId, now?: () => number): MeterDecoder {
  switch (family) {
    case 'ut61e': return createEs51922Decoder({ now });
    case 'ut61eplus': return createUt61EplusDecoder({ now });
    case 'owon-b35': return createOwonB35Decoder({ now });
    case 'fluke-28x': return createFluke28xDecoder({ now });
    case 'brymen-bm86x': return createBm86xDecoder({ now });
    case 'file-bridge': return createFileBridge({ now });
  }
}
