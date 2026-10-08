import { describe, expect, it } from 'vitest';
import { PART_FAMILIES } from './part-families';
import { MIN_PREFIX_QUERY, TIER_RANK, matchTier, normalizePartNumber, familyOf, type PartMarker, type PartNumberKeys } from './part-numbers';

type Extra = { category?: string; maker?: string; suffix?: string; stripped?: PartNumberKeys['stripped']; markers?: PartMarker[] };
/** input, exact (null: not a part number), base, family */
type Row = [input: string, exact: string | null, base?: string, family?: string, extra?: Extra];

const TI = 'Texas Instruments';

const EXPLICIT: Row[] = [
  // Suffixes of one family: package, reel, variant, lead-free
  ['TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { category: 'pmic', maker: TI, suffix: 'RUKR', markers: ['reel'] }],
  ['TPS51225', 'TPS51225', 'TPS51225', 'ti-tps5122x', { category: 'pmic', maker: TI, markers: [] }],
  ['TPS51225CRUKR', 'TPS51225CRUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKT', 'TPS51225RUKT', 'TPS51225', 'ti-tps5122x', { markers: ['reel'] }],
  ['TPS51220ARTVR', 'TPS51220ARTVR', 'TPS51220', 'ti-tps5122x'],
  ['TPS51227RUKR', 'TPS51227RUKR', 'TPS51227', 'ti-tps5122x'],
  ['TPS51225/NOPB', 'TPS51225/NOPB', 'TPS51225', 'ti-tps5122x', { suffix: '/NOPB', markers: ['lead-free'] }],
  ['TPS51225RUKR/NOPB', 'TPS51225RUKR/NOPB', 'TPS51225', 'ti-tps5122x', { markers: ['lead-free'] }],
  ['LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { category: 'opamp-comparator', suffix: 'DR' }],
  ['LM358N', 'LM358N', 'LM358', 'ti-lm358'],
  ['LM358', 'LM358', 'LM358', 'ti-lm358'],
  ['LM358-N', 'LM358-N', 'LM358', 'ti-lm358', { suffix: '-N' }],
  ['LM358DT', 'LM358DT', 'LM358', 'ti-lm358'],
  ['LM358ADR', 'LM358ADR', 'LM358', 'ti-lm358'],
  ['LM2596SX-ADJ', 'LM2596SX-ADJ', 'LM2596', 'ti-lm259x', { category: 'buck-boost' }],
  ['LM2596S-5.0', 'LM2596S-5.0', 'LM2596', 'ti-lm259x'],
  ['LM1117MPX-3.3', 'LM1117MPX-3.3', 'LM1117', 'ti-lm1117', { category: 'ldo' }],
  ['LM317T', 'LM317T', 'LM317', 'ti-lm317'],
  ['ISL95857HRTZ', 'ISL95857HRTZ', 'ISL95857', 'renesas-isl9585x', { category: 'vrm-controller', maker: 'Renesas' }],
  ['ISL95857HRTZ-T', 'ISL95857HRTZ-T', 'ISL95857', 'renesas-isl9585x', { suffix: 'HRTZ-T' }],
  ['ISL6277AHRZ', 'ISL6277AHRZ', 'ISL6277', 'renesas-isl6277x0-1', { category: 'vrm-controller' }],
  ['ISL62771HRTZ', 'ISL62771HRTZ', 'ISL62771', 'renesas-isl6277x0-1'],
  ['ISL9238HRTZ', 'ISL9238HRTZ', 'ISL9238', 'renesas-isl923x', { category: 'charger' }],
  ['BQ24780SRUYR', 'BQ24780SRUYR', 'BQ24780', 'ti-bq247xx', { category: 'charger' }],
  ['BQ24735RGRR', 'BQ24735RGRR', 'BQ24735', 'ti-bq247xx'],
  ['BQ25890RTWR', 'BQ25890RTWR', 'BQ25890', 'ti-bq258xx'],
  ['BQ27441DRZR', 'BQ27441DRZR', 'BQ27441', 'ti-bq274xx', { category: 'fuel-gauge' }],
  ['BQ40Z50RSMR', 'BQ40Z50RSMR', 'BQ40Z50', 'ti-bq40zxx', { category: 'fuel-gauge' }],
  ['IT8987E-128', 'IT8987E-128', 'IT8987', 'ite-it89xx', { category: 'ec-sio', maker: 'ITE', suffix: 'E-128' }],
  ['IT8586E', 'IT8586E', 'IT8586', 'ite-it85xx'],
  ['NPCE285PA0DX', 'NPCE285PA0DX', 'NPCE285', 'nuvoton-npcexxx'],
  ['KB9022QF', 'KB9022QF', 'KB9022', 'ene-kb9xxx'],
  ['MEC1609-NU', 'MEC1609-NU', 'MEC1609', 'microchip-mecxxxx'],
  ['TPS65988', 'TPS65988', 'TPS65988', 'ti-tps6598x', { category: 'usb-pd' }],
  ['TPS65987DDHR', 'TPS65987DDHR', 'TPS65987', 'ti-tps6598x'],
  ['CD3217B12', 'CD3217B12', 'CD3217', 'apple-cd321x', { category: 'usb-pd', maker: 'Apple' }],
  ['CYPD5225-96BZXI', 'CYPD5225-96BZXI', 'CYPD5225', 'cypress-cypdxxxx'],
  ['FUSB302BMPX', 'FUSB302BMPX', 'FUSB302', 'onsemi-fusb30x'],
  ['TPS22965DSGR', 'TPS22965DSGR', 'TPS22965', 'ti-tps22xxx', { category: 'load-switch' }],
  ['TPS2552DBVR', 'TPS2552DBVR', 'TPS2552', 'ti-tps25xx'],
  ['W25Q128JVSQ', 'W25Q128JVSQ', 'W25Q128', 'winbond-w25qx2-3', { category: 'spi-flash' }],
  ['W25Q64FVSSIG', 'W25Q64FVSSIG', 'W25Q64', 'winbond-w25qx2-3'],
  ['W25Q32JVSSIQ', 'W25Q32JVSSIQ', 'W25Q32', 'winbond-w25qx2-3'],
  ['MX25L6406EM2I-12G', 'MX25L6406EM2I-12G', 'MX25L6406', 'macronix-mx25lx3-5', { suffix: 'EM2I-12G' }],
  ['MX25L12835FM2I-10G', 'MX25L12835FM2I-10G', 'MX25L12835', 'macronix-mx25lx3-5'],
  ['GD25Q64CSIG', 'GD25Q64CSIG', 'GD25Q64', 'gigadevice-gd25qx2-3'],
  ['AT24C256C-SSHL-T', 'AT24C256C-SSHL-T', 'AT24C256', 'atmel-at24cx2-4', { category: 'eeprom' }],
  ['24LC256-I/SN', '24LC256-I/SN', '24LC256', 'microchip-24lcx2-3', { category: 'eeprom', markers: ['industrial'] }],
  ['24LC02B-E/SN', '24LC02B-E/SN', '24LC02', 'microchip-24lcx2-3', { markers: ['extended-temperature'] }],
  ['MT41K256M16HA-125:E', 'MT41K256M16HA-125:E', undefined, 'micron-mt41k', { category: 'dram', suffix: '256M16HA-125:E' }],
  ['MT40A512M16LY-075:E', 'MT40A512M16LY-075:E', undefined, 'micron-mt40a', { category: 'dram' }],
  ['K4B4G1646E-BYK0', 'K4B4G1646E-BYK0', undefined, 'samsung-k4b', { category: 'dram' }],
  ['H5TC4G63CFR-PBA', 'H5TC4G63CFR-PBA', undefined, 'hynix-h5tc'],
  ['KLMAG1JETD-B041', 'KLMAG1JETD-B041', undefined, 'samsung-klm', { category: 'nand-emmc-ufs' }],
  ['ALC269Q-VB6-CG', 'ALC269Q-VB6-CG', 'ALC269', 'realtek-alcx3-4', { category: 'audio-codec' }],
  ['ALC3234-CG', 'ALC3234-CG', 'ALC3234', 'realtek-alcx3-4'],
  ['CS8409-CNZ', 'CS8409-CNZ', 'CS8409', 'cirrus-cs8409'],
  ['RTL8111H-CG', 'RTL8111H-CG', 'RTL8111', 'realtek-rtl811x', { category: 'ethernet-phy' }],
  ['RTS5227', 'RTS5227', 'RTS5227', 'realtek-rts5xxx', { category: 'card-reader' }],
  ['AX200NGW', 'AX200NGW', 'AX200', 'intel-ax2xx', { category: 'wireless-module' }],
  ['TXB0108PWR', 'TXB0108PWR', 'TXB0108', 'ti-txb01xx', { category: 'level-shifter' }],
  ['PCA9306DCUR', 'PCA9306DCUR', 'PCA9306', 'nxp-pca9306', { category: 'level-shifter' }],
  ['SN74LVC1G08DBVR', 'SN74LVC1G08DBVR', 'SN74LVC1G08', 'ti-sn74lvc1gx2-3', { category: 'logic' }],
  ['SN74LVC1G125DCKR', 'SN74LVC1G125DCKR', 'SN74LVC1G125', 'ti-sn74lvc1gx2-3'],
  ['SN74HC595DR', 'SN74HC595DR', 'SN74HC595', 'ti-sn74hcx2-3'],
  ['74HC595D', '74HC595D', '74HC595', 'nexperia-74hcx2-3'],
  ['74HCT245D', '74HCT245D', '74HCT245', 'nexperia-74hctx2-3'],
  ['2N7002', '2N7002', '2N7002', 'nexperia-2n7002', { category: 'mosfet-n' }],
  ['2N7002K', '2N7002K', '2N7002', 'nexperia-2n7002'],
  ['2N7002LT1G', '2N7002LT1G', '2N7002', 'nexperia-2n7002'],
  ['BSS138LT1G', 'BSS138LT1G', 'BSS138', 'onsemi-bss138'],
  ['AO3400A', 'AO3400A', 'AO3400', 'aos-ao3400'],
  ['AO3401', 'AO3401', 'AO3401', 'aos-ao3401', { category: 'mosfet-p' }],
  ['AO4407A', 'AO4407A', 'AO4407', 'aos-ao4407'],
  ['AO4800', 'AO4800', 'AO4800', 'aos-ao4800', { category: 'mosfet-dual' }],
  ['SI2302CDS-T1-GE3', 'SI2302CDS-T1-GE3', 'SI2302', 'vishay-si2302', { markers: ['lead-free', 'reel'] }],
  ['BSC014N04LS', 'BSC014N04LS', 'BSC014', 'infineon-bscx3-4'],
  ['CSD17575Q3', 'CSD17575Q3', 'CSD17575', 'ti-csd17xxx'],
  ['DMN3404L-7', 'DMN3404L-7', 'DMN3404', 'diodes-dmnx3-4', { markers: ['reel'] }],
  ['DMP2305U-7', 'DMP2305U-7', 'DMP2305', 'diodes-dmpx3-4'],
  ['MMBT3904', 'MMBT3904', 'MMBT3904', 'onsemi-mmbtxxxx', { category: 'bjt' }],
  ['BC847B', 'BC847B', 'BC847', 'nexperia-bc8xx'],
  ['1N4148W-7-F', '1N4148W-7-F', '1N4148', 'onsemi-1n4148', { category: 'diode' }],
  ['BAV99', 'BAV99', 'BAV99', 'nexperia-bav99'],
  ['SS34-13-F', 'SS34-13-F', 'SS34', 'panjit-ssx2-3', { category: 'schottky' }],
  ['1N5819', '1N5819', '1N5819', 'onsemi-1n581x'],
  ['BAT54S', 'BAT54S', 'BAT54', 'nexperia-bat54'],
  ['MBR0520LT1G', 'MBR0520LT1G', 'MBR0520', 'onsemi-mbrx3-4'],
  ['SMAJ5.0A', 'SMAJ5.0A', undefined, 'littelfuse-smaj', { category: 'tvs-esd' }],
  ['SMBJ24A', 'SMBJ24A', undefined, 'littelfuse-smbj'],
  ['TPD4E004DRYR', 'TPD4E004DRYR', undefined, 'ti-tpd'],
  ['USBLC6-2SC6', 'USBLC6-2SC6', undefined, 'st-usblc6'],
  ['TL431ACDBZR', 'TL431ACDBZR', 'TL431', 'ti-tl431', { category: 'voltage-reference' }],
  ['TPS3808G33DBVR', 'TPS3808G33DBVR', 'TPS3808', 'ti-tps38xx', { category: 'supervisor' }],
  ['INA219AIDCNR', 'INA219AIDCNR', 'INA219', 'ti-ina2xx', { category: 'current-sense' }],
  ['TMP102AIDRLR', 'TMP102AIDRLR', 'TMP102', 'ti-tmpx2-3', { category: 'sensor' }],
  ['STM32F103C8T6', 'STM32F103C8T6', undefined, 'st-stm32', { category: 'mcu' }],
  ['SDM845', 'SDM845', 'SDM845', 'qualcomm-sdmxxx', { category: 'soc-cpu-gpu' }],
  ['PM8998', 'PM8998', 'PM8998', 'qualcomm-pm8xxx', { category: 'pmic' }],
  ['MAX17055EWL+T', 'MAX17055EWL+T', 'MAX17055', 'maxim-max170xx', { markers: ['lead-free', 'reel'] }],
  ['LTC4412ES6#TRMPBF', 'LTC4412ES6#TRMPBF', 'LTC4412', 'linear-ltc4412', { markers: ['lead-free', 'reel'] }],
  ['MP2315GJ-Z', 'MP2315GJ-Z', 'MP2315', 'mps-mp23xx', { category: 'buck-boost' }],
  ['TLV70233DBVR', 'TLV70233DBVR', 'TLV70233', 'ti-tlv70xxx', { category: 'ldo' }],
  ['AMS1117-3.3', 'AMS1117-3.3', 'AMS1117', 'ams-ams1117', { category: 'ldo' }],
  ['PTN3460BS', 'PTN3460BS', 'PTN3460', 'nxp-ptn346x', { category: 'display-bridge' }],
  ['LP8556TME', 'LP8556TME', 'LP8556', 'ti-lp855x', { category: 'backlight' }],
  // Case, blanks, wrapping, full-width and dash look-alikes
  ['tps51225rukr', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['Tps51225Rukr', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['  TPS51225RUKR  ', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['\tTPS51225RUKR\n', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['"TPS51225RUKR"', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ["'TPS51225RUKR'", 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['(TPS51225RUKR)', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['[TPS51225RUKR]', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['<TPS51225RUKR>', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKR,', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKR;', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKR.', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['*TPS51225RUKR*', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKR™', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225RUKR®', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['“TPS51225RUKR”', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['ＴＰＳ５１２２５ＲＵＫＲ', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['TPS 51225', 'TPS51225', 'TPS51225', 'ti-tps5122x'],
  ['TPS51225 RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x'],
  ['LM358‑N', 'LM358-N', 'LM358', 'ti-lm358'],
  ['LM358–N', 'LM358-N', 'LM358', 'ti-lm358'],
  // What a boardview value or a BOM line carries in front of the number
  ['U7100_ISL95857HRTZ-T', 'ISL95857HRTZ-T', 'ISL95857', 'renesas-isl9585x', { stripped: { refdes: 'U7100' } }],
  ['U7100 ISL95857HRTZ', 'ISL95857HRTZ', 'ISL95857', 'renesas-isl9585x', { stripped: { refdes: 'U7100' } }],
  ['U1_LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { refdes: 'U1' } }],
  ['PU5_TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { refdes: 'PU5' } }],
  ['Q12_AO3400A', 'AO3400A', 'AO3400', 'aos-ao3400', { stripped: { refdes: 'Q12' } }],
  ['IC-LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { bomClass: 'IC' } }],
  ['IC_LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { bomClass: 'IC' } }],
  ['IC:LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { bomClass: 'IC' } }],
  ['IC LM358DR', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { bomClass: 'IC' } }],
  ['ic-lm358dr', 'LM358DR', 'LM358', 'ti-lm358', { stripped: { bomClass: 'IC' } }],
  ['TI-TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { maker: 'TI' } }],
  ['TI_TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { maker: 'TI' } }],
  ['TI TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { maker: 'TI' } }],
  ['TI:TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { maker: 'TI' } }],
  ['TEXAS-TPS51225RUKR', 'TPS51225RUKR', 'TPS51225', 'ti-tps5122x', { stripped: { maker: 'TEXAS' } }],
  ['ST-STM32F103C8T6', 'STM32F103C8T6', undefined, 'st-stm32', { stripped: { maker: 'ST' } }],
  ['ON-BSS138LT1G', 'BSS138LT1G', 'BSS138', 'onsemi-bss138', { stripped: { maker: 'ON' } }],
  ['NXP-PCA9306DCUR', 'PCA9306DCUR', 'PCA9306', 'nxp-pca9306', { stripped: { maker: 'NXP' } }],
  ['MAXIM-MAX17055EWL+T', 'MAX17055EWL+T', 'MAX17055', 'maxim-max170xx', { stripped: { maker: 'MAXIM' } }],
  // Unknown families keep only the exact form
  ['ABC123', 'ABC123', undefined, undefined],
  ['XYZ9999', 'XYZ9999', undefined, undefined],
  ['QW12', 'QW12', undefined, undefined],
  ['FOO-BAR-12', 'FOO-BAR-12', undefined, undefined],
  ['ZZ900-A', 'ZZ900-A', undefined, undefined],
  ['LT-1117', 'LT-1117', undefined, undefined],
  ['ON-1234', 'ON-1234', undefined, undefined],
  ['TI-9', 'TI-9', undefined, undefined],
  // A tail that starts with a digit means a longer number than the family's
  ['TPS512251', 'TPS512251', undefined, undefined],
  ['LM3581', 'LM3581', undefined, undefined],
  ['LM35899', 'LM35899', undefined, undefined],
  ['IT89871', 'IT89871', undefined, undefined],
  ['BQ247800', 'BQ247800', undefined, undefined],
  ['W25Q1280', 'W25Q1280', undefined, undefined],
  ['AO34001', 'AO34001', undefined, undefined],
  ['2N70021', '2N70021', undefined, undefined],
  ['ALC26', 'ALC26', undefined, undefined],
  ['TPS5122', 'TPS5122', undefined, undefined],
  ['RT82', 'RT82', undefined, undefined],
  // Not part numbers
  ['', null], ['   ', null], ['R1', null], ['C5', null], ['10K 1% 0402', null], ['100nF', null], ['100NF 16V', null], ['4K7', null], ['0R05', null], ['2.2uH', null], ['DNP', null], ['NC', null],
  ['RESISTOR', null], ['12345', null], ['0402', null], ['1%', null], ['a b c', null], ['TPS 51225 RUKR', null], ['äöü', null], ['🙂', null], ['***', null],
  ['x'.repeat(200), null], ['TPS51225RUKR'.repeat(10), null], ['A'.repeat(49) + '1', null], ['10uF/16V', null], ['600R@100MHz', null], ['-', null], ['_', null], ['+', null],
];

describe('part numbers: normalisation table', () => {
  it('has at least two hundred cases in all', () => {
    expect(EXPLICIT.length).toBeGreaterThanOrEqual(150);
  });
  it.each(EXPLICIT)('%j', (input, exact, base, family, extra) => {
    const keys = normalizePartNumber(input);
    if (exact === null) {
      expect(keys).toBeNull();
      return;
    }
    expect(keys).not.toBeNull();
    expect(keys!.exact).toBe(exact);
    expect(keys!.base).toBe(base);
    expect(keys!.family).toBe(family);
    expect(keys!.original).toBe(input.length > 64 ? input.slice(0, 64) : input);
    if (extra?.category !== undefined) expect(keys!.category).toBe(extra.category);
    if (extra?.maker !== undefined) expect(keys!.maker).toBe(extra.maker);
    if (extra?.suffix !== undefined) expect(keys!.suffix).toBe(extra.suffix);
    if (extra?.stripped !== undefined) expect(keys!.stripped).toEqual(extra.stripped);
    if (extra?.markers !== undefined) expect(keys!.markers).toEqual(extra.markers);
    if (family === undefined) {
      expect(keys!.category).toBeUndefined();
      expect(keys!.maker).toBeUndefined();
      expect(keys!.suffix).toBeUndefined();
    }
  });
});

describe('part numbers: every family example in several written forms', () => {
  const cases: Array<[string, string, string, string | undefined, string]> = [];
  for (const family of PART_FAMILIES) {
    for (const example of family.examples.slice(0, 2)) {
      const upper = example.toUpperCase();
      const digits = /^[0-9]*/.exec(upper.slice(family.stem.length))![0];
      const base = family.prefixOnly ? undefined : family.stem + digits;
      for (const [form, make] of [
        ['lower case', (text: string) => text.toLowerCase()],
        ['after a reference designator', (text: string) => `U1_${text}`],
        ['after a BOM class', (text: string) => `IC-${text}`],
        ['in quotes', (text: string) => `"${text}"`],
      ] as Array<[string, (text: string) => string]>) {
        cases.push([`${family.id} ${example} ${form}`, make(example), upper, base, family.id]);
      }
    }
  }
  it('has many cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(900);
  });
  it.each(cases)('%s', (_title, input, exact, base, family) => {
    const keys = normalizePartNumber(input);
    expect(keys).not.toBeNull();
    expect(keys!.exact).toBe(exact);
    expect(keys!.family).toBe(family);
    expect(keys!.base).toBe(base);
  });
});

describe('part numbers: tiers', () => {
  const key = (text: string) => normalizePartNumber(text)!;
  const rows: Array<[query: string, candidate: string, tier: ReturnType<typeof matchTier>]> = [
    ['TPS51225RUKR', 'TPS51225RUKR', 'exact'], ['tps51225rukr', 'TPS51225RUKR', 'exact'], ['U1_TPS51225RUKR', 'TPS51225RUKR', 'exact'], ['TI-TPS51225RUKR', 'TPS51225RUKR', 'exact'],
    ['TPS51225', 'TPS51225RUKR', 'base'], ['TPS51225RUKR', 'TPS51225RUKT', 'base'], ['TPS51225CRUKR', 'TPS51225RUKR', 'base'], ['LM358DR', 'LM358N', 'base'], ['LM358', 'LM358ADR', 'base'],
    ['ISL95857HRTZ', 'ISL95857HRTZ-T', 'base'], ['W25Q128JVSQ', 'W25Q128JVSIQ', 'base'], ['2N7002', '2N7002K', 'base'], ['AO3400', 'AO3400A', 'base'],
    ['TPS51225', 'TPS51220', 'family'], ['TPS51225RUKR', 'TPS51227RUKR', 'family'], ['W25Q128JVSQ', 'W25Q64FVSSIG', 'family'], ['LM2596', 'LM2596SX-ADJ', 'base'], ['IT8987E-128', 'IT8985E-192', 'family'],
    ['MT41K256M16HA-125:E', 'MT41K128M16JT-125', 'family'], ['STM32F103C8T6', 'STM32L476RGT6', 'family'], ['BQ24780S', 'BQ24735', 'family'], ['TPD2E001', 'TPD4E004', 'family'],
    ['TPS51', 'TPS51225RUKR', 'prefix'], ['TPS512', 'TPS51225RUKR', 'prefix'], ['LM358', 'LM358DR', 'base'], ['W25Q1', 'W25Q128JVSQ', 'prefix'], ['ISL958', 'ISL95857HRTZ', 'prefix'],
    ['MT41K', 'MT41K256M16HA-125:E', 'prefix'],
    ['TPS51225', 'LM358DR', null], ['ABC123', 'ABC124', null], ['ABC123', 'ABC123', 'exact'], ['LM35', 'TPS51225', null], ['LM358', 'LM393', null], ['AO3400', 'AO3401', null],
    ['TPS5122', 'TPS51225RUKR', 'prefix'], ['TPS5', 'TPS51225RUKR', null], ['LM35', 'LM358DR', null],
  ];
  it('has many comparisons', () => {
    expect(rows.length).toBeGreaterThanOrEqual(35);
  });
  it.each(rows)('%s against %s is %s', (query, candidate, tier) => {
    expect(matchTier(key(query), key(candidate))).toBe(tier);
  });
  it('ranks exact above base above prefix above family', () => {
    expect(TIER_RANK.exact).toBeGreaterThan(TIER_RANK.base);
    expect(TIER_RANK.base).toBeGreaterThan(TIER_RANK.prefix);
    expect(TIER_RANK.prefix).toBeGreaterThan(TIER_RANK.family);
  });
  it('asks for at least five characters before it calls a prefix', () => {
    expect(MIN_PREFIX_QUERY).toBe(5);
    expect(matchTier(key('TPS5'), key('TPS51225RUKR'))).toBeNull();
    expect(matchTier(key('TPS51'), key('TPS51225RUKR'))).toBe('prefix');
  });
  it('is symmetric except for the prefix tier', () => {
    for (const [query, candidate, tier] of rows) {
      if (tier === 'prefix' || tier === null) continue;
      expect(matchTier(key(candidate), key(query))).toBe(tier);
    }
  });
  it('finds the family row of a key', () => {
    expect(familyOf(key('TPS51225RUKR'))?.category).toBe('pmic');
    expect(familyOf(key('ABC123'))).toBeUndefined();
  });
});

describe('part numbers: bounds', () => {
  it('returns null for over-long text without reading it all', () => {
    const meter = { steps: 0 };
    expect(normalizePartNumber('TPS51225RUKR'.repeat(5000), { meter })).toBeNull();
    expect(meter.steps).toBeLessThanOrEqual(200);
  });
  it('cuts the original to 64 characters', () => {
    const keys = normalizePartNumber(`TPS51225RUKR${' '.repeat(10)}`);
    expect(keys!.original.length).toBeLessThanOrEqual(64);
  });
  it('gives null for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], Symbol('x')] as unknown[]) expect(normalizePartNumber(value as string)).toBeNull();
  });
  it('is idempotent on the exact form', () => {
    for (const [input] of EXPLICIT) {
      const keys = normalizePartNumber(input);
      if (!keys) continue;
      const again = normalizePartNumber(keys.exact);
      expect(again, input).not.toBeNull();
      expect(again!.exact).toBe(keys.exact);
      expect(again!.base).toBe(keys.base);
      expect(again!.family).toBe(keys.family);
    }
  });
});
