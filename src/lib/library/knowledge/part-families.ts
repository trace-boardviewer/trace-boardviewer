/**
 * Part families and repair function categories (data).
 *
 * Licence: CC0 1.0 (public domain dedication). The table lists FAMILIES of integrated circuits and discrete parts that are
 * common on laptop, phone, graphics-card, console and desktop boards, with the function category a repair technician would
 * file each one under. Every row is written by the developers of this application from general public knowledge of the
 * maker's published naming (the family names printed in datasheet titles and ordering-information pages); no row comes from a
 * scraped catalogue, a distributor feed or a marking-code database, and no row states a price, a stock level or a pin-out.
 * Every row carries a `note` (a short paraphrase of the public datasheet product line); a test fails on a row without one.
 *
 * A row says: a member's part number starts with `stem`, then comes the core number (`digits` more digits, a maximal run of
 * `min..max` digits), then a suffix that starts with a letter or a marker character. The BASE of a member is stem + core
 * digits (the suffix names a variant, a package, a reel or a temperature grade and is dropped). A row with `prefixOnly` has no
 * base: everything after the stem is variant, density or organisation text, so only the family and the category are known.
 * `examples` are real-looking members used by the tests (every example must resolve to its own row).
 *
 * Categories (ids are the keys `library.category.<id>` of the interface catalog):
 *   pmic            multi-rail power management (notebook system power controllers, phone PMICs)
 *   charger         battery chargers and charge controllers (also charge pumps for batteries)
 *   ec-sio          embedded controllers and Super I/O
 *   vrm-controller  multi-phase CPU/GPU core regulator controllers
 *   power-stage     integrated power stages and power blocks (driver plus MOSFETs)
 *   gate-driver     MOSFET gate drivers
 *   buck-boost      switching DC-DC converters and controllers (buck, boost, buck-boost)
 *   ldo             linear regulators, including DDR termination regulators
 *   load-switch     load switches, USB power switches, power multiplexers
 *   usb-pd          USB Type-C and Power Delivery controllers
 *   usb-mux-redriver USB/DisplayPort multiplexers and redrivers
 *   usb-hub         USB hub controllers
 *   display-bridge  video bridges and level translators (eDP, LVDS, MIPI DSI, HDMI, DisplayPort)
 *   backlight       backlight and LED drivers
 *   audio-codec     audio codecs
 *   ethernet-phy    Ethernet controllers and PHYs
 *   wireless-module Wi-Fi/Bluetooth chips and modules
 *   card-reader     memory card reader controllers
 *   spi-flash       SPI NOR flash (firmware storage)
 *   eeprom          serial EEPROM
 *   dram            DRAM
 *   nand-emmc-ufs   NAND, eMMC and UFS storage
 *   clock-gen       clock generators and buffers
 *   oscillator      packaged oscillators
 *   mosfet-n, mosfet-p, mosfet-dual   power and small-signal MOSFETs
 *   bjt             bipolar transistors
 *   diode           switching, rectifier and zener diodes
 *   schottky        Schottky diodes
 *   tvs-esd         TVS and ESD protection
 *   level-shifter   logic level translators
 *   opamp-comparator operational amplifiers and comparators
 *   current-sense   current and power monitors
 *   fuel-gauge      battery fuel gauges and pack managers
 *   battery-protection battery protection ICs
 *   supervisor      voltage supervisors and reset generators
 *   voltage-reference shunt and series references
 *   logic           logic gates, expanders, programmable logic
 *   sensor          temperature, motion and environment sensors
 *   fan-ctl         fan and thermal controllers
 *   soc-cpu-gpu     processors and systems on chip
 *   mcu             microcontrollers
 *   connector       connectors (assigned by structure rules elsewhere, not by part number)
 *   unknown-ic      an integrated circuit with no evidence for a category
 */

export const PART_CATEGORIES = [
  'pmic', 'charger', 'ec-sio', 'vrm-controller', 'power-stage', 'gate-driver', 'buck-boost', 'ldo', 'load-switch', 'usb-pd', 'usb-mux-redriver',
  'usb-hub', 'display-bridge', 'backlight', 'audio-codec', 'ethernet-phy', 'wireless-module', 'card-reader', 'spi-flash', 'eeprom', 'dram',
  'nand-emmc-ufs', 'clock-gen', 'oscillator', 'mosfet-n', 'mosfet-p', 'mosfet-dual', 'bjt', 'diode', 'schottky', 'tvs-esd', 'level-shifter',
  'opamp-comparator', 'current-sense', 'fuel-gauge', 'battery-protection', 'supervisor', 'voltage-reference', 'logic', 'sensor', 'fan-ctl',
  'soc-cpu-gpu', 'mcu', 'connector', 'unknown-ic',
] as const;
export type PartCategory = typeof PART_CATEGORIES[number];

export interface PartFamily {
  /** Stable family id: maker, stem and core length ("ti-tps5122x"). */
  readonly id: string;
  readonly category: PartCategory;
  /** The maker's name, used nominatively. */
  readonly maker: string;
  /** Upper-case characters every member starts with. */
  readonly stem: string;
  /** Digits after the stem that form the core number (a maximal run of min..max digits). Both 0 for a stem that is the whole core. */
  readonly minDigits: number;
  readonly maxDigits: number;
  /** No base: the text after the stem is not a suffix (density, organisation, variant letters). */
  readonly prefixOnly: boolean;
  /** Source note: a paraphrase of the public datasheet product line. */
  readonly note: string;
  /** Real-looking members; each must resolve to this row. */
  readonly examples: readonly string[];
}

const MAKER_ID: Readonly<Record<string, string>> = {
  'Texas Instruments': 'ti', 'Analog Devices': 'adi', 'Maxim': 'maxim', 'onsemi': 'onsemi', 'Infineon': 'infineon', 'Renesas': 'renesas', 'Richtek': 'richtek',
  'Monolithic Power Systems': 'mps', 'NXP': 'nxp', 'STMicroelectronics': 'st', 'Microchip': 'microchip', 'Realtek': 'realtek', 'ITE': 'ite', 'Nuvoton': 'nuvoton',
  'ENE': 'ene', 'Winbond': 'winbond', 'Macronix': 'macronix', 'GigaDevice': 'gigadevice', 'Micron': 'micron', 'Samsung': 'samsung', 'SK hynix': 'hynix',
  'Toshiba': 'toshiba', 'Nanya': 'nanya', 'ISSI': 'issi', 'Diodes Incorporated': 'diodes', 'Alpha and Omega': 'aos', 'Vishay': 'vishay', 'Nexperia': 'nexperia',
  'Cirrus Logic': 'cirrus', 'Conexant': 'conexant', 'Qualcomm': 'qualcomm', 'MediaTek': 'mediatek', 'Broadcom': 'broadcom', 'Intel': 'intel', 'Parade': 'parade',
  'Chrontel': 'chrontel', 'Lontium': 'lontium', 'Cypress': 'cypress', 'Silergy': 'silergy', 'Analogix': 'analogix', 'Pericom': 'pericom', 'Atheros': 'atheros',
  'Fairchild': 'fairchild', 'Rockchip': 'rockchip', 'Linear Technology': 'linear', 'Skyworks': 'skyworks', 'Holtek': 'holtek', 'Torex': 'torex', 'Microne': 'microne',
  'Advanced Monolithic Systems': 'ams', 'Genesys': 'genesys', 'SiTime': 'sitime', 'Silicon Labs': 'silabs', 'Dialog': 'dialog', 'Sensirion': 'sensirion', 'Bosch': 'bosch',
  'InvenSense': 'invensense', 'Allegro': 'allegro', 'Rohm': 'rohm', 'Panjit': 'panjit', 'Littelfuse': 'littelfuse', 'Semtech': 'semtech', 'Fudan': 'fudan', 'Boya': 'boya',
  'XTX': 'xtx', 'EON': 'eon', 'Spansion': 'spansion', 'Atmel': 'atmel', 'Apple': 'apple', 'Elpida': 'elpida', 'O2Micro': 'o2micro', 'Anpec': 'anpec', 'Sanyo': 'sanyo',
  'Pulse': 'pulse', 'Kioxia': 'kioxia', 'Alcor': 'alcor', 'Intersil': 'intersil', 'Exar': 'exar',
};

const ROWS: PartFamily[] = [];
const IDS = new Set<string>();

function add(category: PartCategory, maker: string, stem: string, minDigits: number, maxDigits: number, prefixOnly: boolean, note: string, examples: string[]): void {
  const makerId = MAKER_ID[maker] ?? maker.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const shape = prefixOnly ? '' : minDigits === 0 && maxDigits === 0 ? '' : minDigits === maxDigits ? 'x'.repeat(maxDigits) : `x${minDigits}-${maxDigits}`;
  let id = `${makerId}-${stem.toLowerCase()}${shape}`;
  if (IDS.has(id)) id += `-${category}`;
  IDS.add(id);
  ROWS.push({ id, category, maker, stem, minDigits, maxDigits, prefixOnly, note, examples });
}
/** A family whose members continue the stem with `min..max` digits. */
const fam = (category: PartCategory, maker: string, stem: string, min: number, max: number, note: string, ...examples: string[]): void => add(category, maker, stem, min, max, false, note, examples);
/** A single part number family: the stem is the whole core. */
const one = (category: PartCategory, maker: string, stem: string, note: string, ...examples: string[]): void => add(category, maker, stem, 0, 0, false, note, examples);
/** A family known by its stem only. */
const pre = (category: PartCategory, maker: string, stem: string, note: string, ...examples: string[]): void => add(category, maker, stem, 0, 0, true, note, examples);

// ---- Notebook and phone power management ---------------------------------------------------------------------------
fam('pmic', 'Texas Instruments', 'TPS5122', 1, 1, 'dual synchronous step-down controller with LDOs for notebook system power', 'TPS51225RUKR', 'TPS51220ARTVR', 'TPS51227RUKR');
fam('pmic', 'Texas Instruments', 'TPS5128', 1, 1, 'dual synchronous buck controller for notebook system power', 'TPS51285BRUKR', 'TPS51285RUKT');
fam('pmic', 'Texas Instruments', 'TPS5111', 1, 1, 'DDR memory power solution: synchronous buck controller with termination LDO', 'TPS51116RGER', 'TPS51116');
fam('ldo', 'Texas Instruments', 'TPS5120', 1, 1, 'DDR termination regulator, sink and source', 'TPS51200DRCR', 'TPS51200');
one('ldo', 'Texas Instruments', 'TPS51206', 'DDR2/3/4 termination regulator with buffered reference', 'TPS51206DSQR');
fam('pmic', 'Richtek', 'RT820', 1, 1, 'dual step-down controller for notebook system power', 'RT8205', 'RT8206BGQW', 'RT8205LGQW');
fam('pmic', 'Richtek', 'RT822', 1, 1, 'dual synchronous step-down controller for notebooks', 'RT8223PGQW', 'RT8223');
fam('pmic', 'Qualcomm', 'PM8', 3, 3, 'phone power management IC (PM89xx and PM81xx series)', 'PM8998', 'PM8150B', 'PM8941');
fam('pmic', 'Qualcomm', 'PMI8', 3, 3, 'phone power management IC with charger (PMI89xx series)', 'PMI8998', 'PMI8994');
fam('pmic', 'Qualcomm', 'PMK8', 3, 3, 'phone clock and power management IC', 'PMK8350', 'PMK8002');
fam('pmic', 'Qualcomm', 'PM6', 2, 3, 'phone power management IC (PM6xx series)', 'PM660', 'PM660L', 'PM670');
fam('pmic', 'Qualcomm', 'PM7', 3, 3, 'phone power management IC (PM7xxx series)', 'PM7250B', 'PM7325');
fam('pmic', 'MediaTek', 'MT635', 1, 1, 'phone power management IC (MT6357, MT6358, MT6359)', 'MT6358', 'MT6359P', 'MT6357');
fam('pmic', 'Samsung', 'S2MPS', 2, 2, 'phone power management IC (S2MPS series)', 'S2MPS11', 'S2MPS15');
// ---- Chargers and fuel gauges ---------------------------------------------------------------------------------------
fam('charger', 'Texas Instruments', 'BQ247', 2, 2, 'SMBus notebook battery charge controller family', 'BQ24780SRUYR', 'BQ24735RGRR', 'BQ24715RGRR', 'BQ24770RUYR');
fam('charger', 'Texas Instruments', 'BQ258', 2, 2, 'I2C battery charger with USB input (BQ2589x)', 'BQ25890RTWR', 'BQ25895RTWR');
fam('charger', 'Texas Instruments', 'BQ256', 2, 2, 'I2C battery charger for single-cell Li-ion (BQ256xx)', 'BQ25601RTWR', 'BQ25606RTWR');
fam('charger', 'Texas Instruments', 'BQ2461', 1, 1, 'standalone synchronous switch-mode battery charger', 'BQ24610RGER', 'BQ24617RGER');
fam('charger', 'Renesas', 'ISL923', 1, 1, 'narrow-VDC buck-boost battery charger (ISL9237, ISL9238)', 'ISL9238HRTZ', 'ISL9237HRTZ');
fam('charger', 'Renesas', 'ISL924', 1, 1, 'narrow-VDC buck-boost battery charger (ISL9240, ISL9241)', 'ISL9240HRTZ', 'ISL9241IRTZ');
fam('charger', 'Intersil', 'ISL8873', 1, 1, 'SMBus battery charger controller (ISL88731)', 'ISL88731AHRTZ', 'ISL88731');
fam('charger', 'Qualcomm', 'SMB', 4, 4, 'phone switch-mode battery charger (SMB1351, SMB1390)', 'SMB1351', 'SMB1390');
fam('fuel-gauge', 'Texas Instruments', 'BQ274', 2, 2, 'single-cell battery fuel gauge (BQ27441, BQ27421)', 'BQ27441DRZR', 'BQ27421YZFR');
fam('fuel-gauge', 'Texas Instruments', 'BQ28Z', 3, 3, 'battery pack fuel gauge and protector (BQ28Z610)', 'BQ28Z610DRZR', 'BQ28Z610');
fam('fuel-gauge', 'Texas Instruments', 'BQ40Z', 2, 2, 'multi-cell battery pack manager (BQ40Z50)', 'BQ40Z50RSMR', 'BQ40Z50');
fam('fuel-gauge', 'Texas Instruments', 'BQ30Z', 2, 2, 'multi-cell battery pack manager (BQ30Z55)', 'BQ30Z55DBTR', 'BQ30Z55');
fam('fuel-gauge', 'Texas Instruments', 'BQ20Z', 2, 3, 'battery gas gauge for pack electronics (BQ20Z45, BQ20Z95)', 'BQ20Z45DBT', 'BQ20Z95DBT');
fam('fuel-gauge', 'Maxim', 'MAX170', 2, 2, 'ModelGauge battery fuel gauge (MAX17048, MAX17050, MAX17055)', 'MAX17048G+T10', 'MAX17055EWL+T', 'MAX17050');
fam('battery-protection', 'Texas Instruments', 'BQ297', 2, 2, 'single-cell Li-ion battery protection (BQ297xx)', 'BQ29700DSER', 'BQ29707DSER');
one('battery-protection', 'Fortune', 'DW01', 'single-cell lithium battery protection IC, paired with a dual MOSFET', 'DW01A', 'DW01');
// ---- Embedded controllers and Super I/O --------------------------------------------------------------------------------
fam('ec-sio', 'ITE', 'IT89', 2, 2, 'notebook embedded controller (IT8985, IT8987)', 'IT8987E-128', 'IT8985E-192', 'IT8987VG');
fam('ec-sio', 'ITE', 'IT85', 2, 2, 'notebook embedded controller (IT8586, IT8587, IT8528)', 'IT8586E-LQFP', 'IT8528E');
fam('ec-sio', 'ITE', 'IT86', 2, 2, 'desktop Super I/O with hardware monitor (IT8613, IT8625, IT8688)', 'IT8613E', 'IT8688E');
fam('ec-sio', 'ITE', 'IT87', 2, 2, 'desktop Super I/O with hardware monitor (IT8705, IT8728)', 'IT8728F', 'IT8705F');
fam('ec-sio', 'Nuvoton', 'NPCE', 3, 3, 'notebook embedded controller (NPCE285, NPCE388)', 'NPCE285PA0DX', 'NPCE388NA0DX');
fam('ec-sio', 'Nuvoton', 'NCT6', 3, 4, 'desktop Super I/O with hardware monitor (NCT6776, NCT6791)', 'NCT6791D', 'NCT6776F');
fam('ec-sio', 'Nuvoton', 'WPCE', 3, 3, 'embedded controller for notebooks (WPCE775)', 'WPCE775LA0DG');
fam('ec-sio', 'ENE', 'KB9', 3, 3, 'notebook keyboard and embedded controller (KB9010, KB9022)', 'KB9010QF', 'KB9022QF', 'KB9012QF');
fam('ec-sio', 'ENE', 'KB3', 3, 3, 'notebook keyboard and embedded controller (KB3310, KB3930)', 'KB3310QF', 'KB3930QF');
fam('ec-sio', 'Microchip', 'MEC', 4, 4, 'notebook embedded controller (MEC1609, MEC1701)', 'MEC1609-NU', 'MEC1701Q-B0-I', 'MEC1521H-B0-I');
// ---- CPU and GPU core regulators and power stages ---------------------------------------------------------------------
fam('vrm-controller', 'Renesas', 'ISL9585', 1, 1, 'Intel IMVP8 multiphase core regulator controller (ISL95857)', 'ISL95857HRTZ', 'ISL95857');
one('vrm-controller', 'Renesas', 'ISL95712', 'notebook IMVP7 multiphase core regulator controller', 'ISL95712HRTZ');
fam('vrm-controller', 'Renesas', 'ISL6277', 0, 1, 'AMD mobile SVI2 multiphase core regulator controller', 'ISL6277AHRZ', 'ISL62771HRTZ');
fam('vrm-controller', 'Analog Devices', 'ADP321', 1, 1, 'programmable 1-, 2- or 3-phase mobile CPU buck controller (ADP3211, ADP3212)', 'ADP3211MNR2G', 'ADP3212MNR2G');
fam('vrm-controller', 'Infineon', 'IR3520', 1, 1, 'digital multiphase controller (IR35201)', 'IR35201MTRPBF', 'IR35201');
fam('power-stage', 'Infineon', 'IR355', 1, 1, 'PowIRstage integrated power stage family (IR3550, IR3553, IR3556)', 'IR3553MTRPBF', 'IR3556MTRPBF', 'IR3550MTRPBF');
fam('power-stage', 'onsemi', 'NCP30215', 1, 1, 'smart power stage (NCP302150, NCP302155)', 'NCP302150MNTWG', 'NCP302155MNTWG');
fam('power-stage', 'Texas Instruments', 'CSD953', 2, 2, 'synchronous buck NexFET power stage (CSD95372, CSD95377)', 'CSD95377CQ4M', 'CSD95372BQ5MC');
fam('power-stage', 'Texas Instruments', 'CSD87', 3, 3, 'synchronous buck NexFET power block (CSD87350)', 'CSD87350Q5D', 'CSD87588N');
fam('power-stage', 'Renesas', 'ISL9922', 1, 1, 'smart power stage (ISL99227B)', 'ISL99227BFRZ-T', 'ISL99227');
fam('power-stage', 'Fairchild', 'FDMF', 4, 4, 'DrMOS integrated driver and MOSFET power stage (FDMF3170, FDMF6823)', 'FDMF3170', 'FDMF6823C');
fam('gate-driver', 'Renesas', 'ISL620', 1, 1, 'synchronous buck MOSFET driver family (ISL6207, ISL6208)', 'ISL6208CBZ', 'ISL6207CBZ-T');
// ---- Switching converters and linear regulators --------------------------------------------------------------------
fam('buck-boost', 'Texas Instruments', 'TPS54', 3, 3, 'buck converter family (TPS54331, TPS54560)', 'TPS54331DR', 'TPS54560DDAR', 'TPS54060DGQR');
fam('buck-boost', 'Texas Instruments', 'TPS62', 3, 3, 'step-down converter family (TPS62130, TPS62740)', 'TPS62130RGTR', 'TPS62740DSSR');
fam('buck-boost', 'Texas Instruments', 'TPS63', 3, 3, 'buck-boost converter family (TPS63020, TPS63050)', 'TPS63020DSJR', 'TPS63050YFFR');
fam('buck-boost', 'Texas Instruments', 'TPS610', 2, 2, 'boost converter family (TPS61040, TPS61085, TPS61088)', 'TPS61088RHLR', 'TPS61085DGKR', 'TPS61040DBVR');
fam('buck-boost', 'Texas Instruments', 'TLV62', 3, 3, 'step-down converter family (TLV62565)', 'TLV62565DBVR', 'TLV62080DSGR');
fam('buck-boost', 'Texas Instruments', 'TLV61', 3, 3, 'boost converter family (TLV61070)', 'TLV61070ADBVR', 'TLV61220DBVR');
fam('buck-boost', 'Monolithic Power Systems', 'MP15', 2, 2, 'step-down converter family (MP1584, MP1593)', 'MP1584EN-LF-Z', 'MP1593DN');
fam('buck-boost', 'Monolithic Power Systems', 'MP23', 2, 2, 'step-down converter family (MP2307, MP2315, MP2359)', 'MP2315GJ-Z', 'MP2359DJ-LF-P', 'MP2307DN-LF-Z');
fam('buck-boost', 'Silergy', 'SY80', 2, 2, 'step-down converter family (SY8008, SY8089)', 'SY8089AAAC', 'SY8008BAC');
fam('buck-boost', 'Texas Instruments', 'LM259', 1, 1, 'simple switcher step-down regulator (LM2596)', 'LM2596S-5.0', 'LM2596SX-ADJ');
one('buck-boost', 'Texas Instruments', 'LM2576', 'simple switcher step-down regulator', 'LM2576T-5.0', 'LM2576S');
fam('ldo', 'Texas Instruments', 'TPS7A', 4, 4, 'low-noise linear regulator family (TPS7A4700)', 'TPS7A4700RGWR', 'TPS7A3301RGWR');
fam('ldo', 'Texas Instruments', 'TPS73', 3, 3, 'low-dropout regulator family (TPS73633)', 'TPS73633DBVR', 'TPS73618DBVT');
fam('ldo', 'Texas Instruments', 'TPS79', 3, 3, 'low-dropout regulator family (TPS79318)', 'TPS79318DBVR', 'TPS79333DBVT');
fam('ldo', 'Texas Instruments', 'TLV70', 3, 3, 'low-dropout regulator family (TLV70233)', 'TLV70233DBVR', 'TLV70018DSER');
fam('ldo', 'Texas Instruments', 'TLV75', 3, 3, 'low-dropout regulator family (TLV75533)', 'TLV75533PDBVR', 'TLV75518PDBVR');
one('ldo', 'Texas Instruments', 'LP5907', 'ultra-low-noise low-dropout regulator', 'LP5907SNX-3.3', 'LP5907MFX-1.8');
one('ldo', 'Texas Instruments', 'LP2985', 'low-noise low-dropout regulator', 'LP2985-33DBVR', 'LP2985AIM5-3.3');
one('ldo', 'Texas Instruments', 'TLV1117', 'low-dropout positive regulator', 'TLV1117-33CDCYR', 'TLV1117LV33DCYR');
one('ldo', 'Texas Instruments', 'LM1117', 'low-dropout positive regulator', 'LM1117MPX-3.3', 'LM1117T-ADJ');
one('ldo', 'Texas Instruments', 'LM317', 'adjustable three-terminal positive regulator', 'LM317T', 'LM317LZ');
fam('ldo', 'Texas Instruments', 'LM78', 2, 2, 'fixed positive linear regulator (LM7805, LM7812)', 'LM7805CT', 'LM7812');
one('ldo', 'Advanced Monolithic Systems', 'AMS1117', 'low-dropout positive regulator', 'AMS1117-3.3', 'AMS1117-ADJ');
one('ldo', 'Diodes Incorporated', 'AP2112', 'low-dropout regulator', 'AP2112K-3.3TRG1', 'AP2112K-1.8');
one('ldo', 'Torex', 'XC6206', 'low-power low-dropout regulator', 'XC6206P332MR', 'XC6206P332PR');
one('ldo', 'Microne', 'ME6211', 'low-dropout regulator', 'ME6211C33M5G-N', 'ME6211C33');
fam('ldo', 'Holtek', 'HT73', 2, 2, 'low-dropout voltage regulator (HT7333, HT7350)', 'HT7333-A', 'HT7350');
fam('ldo', 'Microchip', 'MIC52', 2, 2, 'low-dropout regulator family (MIC5205, MIC5219)', 'MIC5219-3.3YM5', 'MIC5205-3.3YM5');
one('ldo', 'Richtek', 'RT9193', 'low-noise low-dropout regulator', 'RT9193-33GB', 'RT9193-28GB');
one('ldo', 'Richtek', 'RT9013', '500 mA low-dropout regulator', 'RT9013-33GB', 'RT9013-18GB');
// ---- Load switches and power multiplexers ----------------------------------------------------------------------------
fam('load-switch', 'Texas Instruments', 'TPS22', 3, 3, 'load switch family (TPS22965, TPS22990)', 'TPS22965DSGR', 'TPS22990DMLR', 'TPS22918DBVR');
fam('load-switch', 'Texas Instruments', 'TPS211', 1, 1, 'power multiplexer (TPS2113, TPS2115)', 'TPS2113APWR', 'TPS2115APWR');
fam('load-switch', 'Texas Instruments', 'TPS20', 2, 2, 'USB current-limited power distribution switch (TPS2051, TPS2065)', 'TPS2051BDBVR', 'TPS2065DDBVR');
fam('load-switch', 'Texas Instruments', 'TPS25', 2, 2, 'adjustable current-limit power switch (TPS2552)', 'TPS2552DBVR', 'TPS2553DBVR');
fam('load-switch', 'Fairchild', 'FPF2', 3, 3, 'integrated load switch family (FPF2123)', 'FPF2123', 'FPF2700MX');
fam('load-switch', 'Richtek', 'RT974', 1, 1, 'load switch (RT9742)', 'RT9742GGJ5', 'RT9742');
one('load-switch', 'Linear Technology', 'LTC4412', 'PowerPath controller for ideal-diode switching', 'LTC4412ES6#TRMPBF', 'LTC4412');
// ---- USB-C, power delivery and multiplexers ----------------------------------------------------------------------------
fam('usb-pd', 'Texas Instruments', 'TPS6598', 1, 1, 'USB Type-C and Power Delivery controller (TPS65982, TPS65987, TPS65988)', 'TPS65982DDHR', 'TPS65987DDHRSHR', 'TPS65988');
fam('usb-pd', 'Apple', 'CD321', 1, 1, 'USB-C port controller (CD3215, CD3217)', 'CD3215C00', 'CD3217B12');
fam('usb-pd', 'Cypress', 'CYPD', 4, 4, 'EZ-PD Power Delivery controller (CYPD3177, CYPD5225)', 'CYPD5225-96BZXI', 'CYPD3177-24LQXQ');
fam('usb-pd', 'STMicroelectronics', 'STUSB', 4, 4, 'USB Type-C Power Delivery controller (STUSB4500)', 'STUSB4500QTR', 'STUSB4700');
fam('usb-pd', 'onsemi', 'FUSB30', 1, 1, 'USB Type-C controller with Power Delivery (FUSB302)', 'FUSB302BMPX', 'FUSB303BTMX');
fam('usb-pd', 'Richtek', 'RT171', 1, 1, 'USB Power Delivery controller and Type-C PHY (RT1711, RT1715)', 'RT1715', 'RT1711HWSC');
fam('usb-pd', 'Analogix', 'ANX74', 2, 2, 'USB Type-C port controller (ANX7447)', 'ANX7447', 'ANX7451');
fam('usb-pd', 'NXP', 'PTN511', 1, 1, 'USB Power Delivery TCPC PHY (PTN5110)', 'PTN5110HQZ', 'PTN5110NHQZ');
fam('usb-mux-redriver', 'ITE', 'IT520', 1, 1, 'USB Type-C alternate-mode multiplexer (IT5205)', 'IT5205FN', 'IT5205');
fam('usb-mux-redriver', 'Texas Instruments', 'HD3SS', 3, 4, 'USB Type-C port controller and multiplexer (HD3SS3220)', 'HD3SS3220RNHR', 'HD3SS460');
fam('usb-mux-redriver', 'Pericom', 'PI3USB', 5, 5, 'USB 3.x and DisplayPort multiplexer (PI3USB30532)', 'PI3USB30532ZLE', 'PI3USB31532');
fam('usb-mux-redriver', 'Pericom', 'PI3DPX', 3, 4, 'DisplayPort multiplexer (PI3DPX1205, PI3DPX1207)', 'PI3DPX1205AZHE', 'PI3DPX1207');
fam('usb-hub', 'Microchip', 'USB25', 2, 2, 'USB 2.0 hub controller (USB2514, USB2517)', 'USB2514B-AEZG', 'USB2517I');
fam('usb-hub', 'Microchip', 'USB35', 2, 2, 'USB 2.0 hub controller (USB3503)', 'USB3503A-I', 'USB3503');
fam('usb-hub', 'Texas Instruments', 'TUSB804', 1, 1, 'USB 3.0 hub controller (TUSB8041)', 'TUSB8041RGCR', 'TUSB8044');
// ---- Display bridges, level translators for video, backlight -------------------------------------------------------------
fam('display-bridge', 'NXP', 'PTN346', 1, 1, 'eDP to LVDS bridge (PTN3460)', 'PTN3460BS', 'PTN3460IBS');
fam('display-bridge', 'NXP', 'PTN336', 1, 1, 'DisplayPort to HDMI level shifter (PTN3360)', 'PTN3360DBS', 'PTN3360BBS');
fam('display-bridge', 'Chrontel', 'CH751', 1, 1, 'eDP to LVDS bridge (CH7511)', 'CH7511B-BF', 'CH7511');
fam('display-bridge', 'Texas Instruments', 'SN65DSI', 2, 2, 'MIPI DSI to LVDS or eDP bridge (SN65DSI83, SN65DSI86)', 'SN65DSI83ZQER', 'SN65DSI86ZQER');
fam('display-bridge', 'Texas Instruments', 'SN65LVDS', 2, 3, 'FlatLink LVDS serializer and receiver family', 'SN65LVDS93ADGG', 'SN65LVDS93');
fam('display-bridge', 'Toshiba', 'TC358', 3, 3, 'MIPI DSI and DisplayPort bridge family (TC358762, TC358775)', 'TC358775XBG', 'TC358762XBG', 'TC358867XBG');
one('display-bridge', 'Lontium', 'LT8912B', 'MIPI DSI to HDMI and LVDS bridge', 'LT8912B');
fam('display-bridge', 'Lontium', 'LT92', 2, 2, 'MIPI and LVDS bridge family (LT9211)', 'LT9211', 'LT9211C');
fam('display-bridge', 'ITE', 'IT65', 2, 2, 'DisplayPort transmitter (IT6505)', 'IT6505FN', 'IT6505');
fam('display-bridge', 'ITE', 'IT661', 2, 2, 'HDMI transmitter (IT66121)', 'IT66121FN', 'IT66121');
fam('display-bridge', 'Parade', 'PS86', 2, 2, 'eDP and DisplayPort to LVDS bridge family (PS8622, PS8625)', 'PS8625', 'PS8622');
one('display-bridge', 'Chipone', 'ICN6211', 'MIPI DSI to RGB bridge', 'ICN6211');
fam('backlight', 'Texas Instruments', 'LP855', 1, 1, 'backlight LED driver (LP8550 to LP8556)', 'LP8550TMX', 'LP8556TME');
fam('backlight', 'Texas Instruments', 'TPS6116', 1, 1, 'boost white-LED driver (TPS61160, TPS61165)', 'TPS61165DRVR', 'TPS61160DRVR');
fam('backlight', 'Texas Instruments', 'TPS6115', 1, 1, 'boost white-LED driver (TPS61158)', 'TPS61158DRVR', 'TPS61158');
fam('backlight', 'Monolithic Power Systems', 'MP33', 2, 2, 'white-LED backlight driver (MP3309, MP3394)', 'MP3309CGQ-Z', 'MP3394SGR');
fam('backlight', 'O2Micro', 'OZ99', 2, 2, 'LED backlight driver family (OZ9902, OZ9976)', 'OZ9976', 'OZ9902');
// ---- Audio, Ethernet, wireless, card readers -------------------------------------------------------------------------
fam('audio-codec', 'Realtek', 'ALC', 3, 4, 'high-definition audio codec (ALC269, ALC892, ALC3234)', 'ALC269Q-VB6-CG', 'ALC3234-CG', 'ALC892', 'ALC1220-VB');
fam('audio-codec', 'Cirrus Logic', 'CS42L', 2, 2, 'low-power audio codec (CS42L42, CS42L51)', 'CS42L42', 'CS42L51-CNZ');
one('audio-codec', 'Cirrus Logic', 'CS8409', 'high-definition audio bridge and codec', 'CS8409-CNZ', 'CS8409');
fam('audio-codec', 'Cirrus Logic', 'CS420', 1, 1, 'high-definition audio codec (CS4206, CS4208)', 'CS4208-CNZ', 'CS4206');
fam('audio-codec', 'Cirrus Logic', 'WM8', 3, 3, 'audio codec (WM8731, WM8960)', 'WM8960CGEFL/RV', 'WM8731SEDS');
fam('audio-codec', 'Conexant', 'CX20', 3, 3, 'high-definition audio codec (CX20751, CX20724)', 'CX20751-11Z', 'CX20724');
fam('audio-codec', 'IDT', '92HD', 2, 3, 'high-definition audio codec (92HD91)', '92HD91BXX5NLGXTAX8', '92HD80B1');
fam('audio-codec', 'Realtek', 'RT56', 2, 2, 'audio codec (RT5640, RT5682)', 'RT5682I', 'RT5640', 'RT5660');
fam('audio-codec', 'Qualcomm', 'WCD9', 3, 3, 'phone audio codec (WCD9335, WCD9340)', 'WCD9340', 'WCD9335');
pre('audio-codec', 'Texas Instruments', 'TLV320', 'low-power audio codec family (TLV320AIC3104)', 'TLV320AIC3104IRHBR', 'TLV320AIC3254IRHBT');
fam('ethernet-phy', 'Realtek', 'RTL811', 1, 1, 'PCI Express gigabit Ethernet controller (RTL8111, RTL8118)', 'RTL8111H-CG', 'RTL8111G-CG', 'RTL8118AS');
fam('ethernet-phy', 'Realtek', 'RTL816', 1, 1, 'PCI Express gigabit Ethernet controller (RTL8168)', 'RTL8168H-CG', 'RTL8168');
fam('ethernet-phy', 'Realtek', 'RTL812', 1, 1, 'PCI Express 2.5 gigabit Ethernet controller (RTL8125)', 'RTL8125B-CG', 'RTL8125BG');
fam('ethernet-phy', 'Realtek', 'RTL815', 1, 1, 'USB 3.0 gigabit Ethernet controller (RTL8153)', 'RTL8153-VB-CG', 'RTL8153B');
fam('ethernet-phy', 'Realtek', 'RTL821', 1, 1, 'gigabit Ethernet transceiver (RTL8211)', 'RTL8211F-CG', 'RTL8211E-VB-CG');
fam('ethernet-phy', 'Realtek', 'RTL820', 1, 1, 'fast Ethernet transceiver (RTL8201)', 'RTL8201F-CG', 'RTL8201CP');
fam('ethernet-phy', 'Atheros', 'AR81', 2, 2, 'PCI Express Ethernet controller (AR8151, AR8161)', 'AR8151-BL1A', 'AR8161-AL1A');
fam('ethernet-phy', 'Atheros', 'AR80', 2, 2, 'gigabit Ethernet transceiver (AR8035)', 'AR8035-A-AL1A', 'AR8031-AL1A');
fam('ethernet-phy', 'Intel', 'I21', 1, 1, 'gigabit Ethernet controller and PHY (I210, I211, I219)', 'I219-V', 'I211-AT', 'I210-AT');
fam('ethernet-phy', 'Broadcom', 'BCM57', 3, 3, 'NetXtreme gigabit Ethernet controller (BCM57762)', 'BCM57762A0KMLG', 'BCM57780');
fam('ethernet-phy', 'Microchip', 'KSZ90', 2, 2, 'gigabit Ethernet transceiver (KSZ9031)', 'KSZ9031RNXCA', 'KSZ9021RN');
fam('card-reader', 'Realtek', 'RTS5', 3, 3, 'PCI Express memory card reader controller (RTS5227, RTS5260)', 'RTS5227', 'RTS5260-GR', 'RTS5229');
fam('card-reader', 'Alcor', 'AU6', 3, 3, 'memory card reader controller (AU6371)', 'AU6371', 'AU6625');
fam('wireless-module', 'Intel', 'AX2', 2, 2, 'Wi-Fi 6 and 6E module (AX200, AX201, AX210)', 'AX200NGW', 'AX210NGW', 'AX201D2WL');
fam('wireless-module', 'Broadcom', 'BCM43', 2, 3, 'Wi-Fi and Bluetooth combo chip (BCM4350, BCM43602)', 'BCM4350', 'BCM43602', 'BCM4377');
fam('wireless-module', 'Qualcomm', 'QCA', 4, 4, 'Wi-Fi and Bluetooth chip (QCA6174, QCA9377)', 'QCA6174A', 'QCA9377-3');
fam('wireless-module', 'Qualcomm', 'WCN', 4, 4, 'phone Wi-Fi and Bluetooth chip (WCN3990)', 'WCN3990', 'WCN3998');
fam('wireless-module', 'MediaTek', 'MT79', 2, 2, 'Wi-Fi 6 chip (MT7921, MT7922)', 'MT7921K', 'MT7922A12');
fam('wireless-module', 'Realtek', 'RTL88', 2, 2, 'Wi-Fi chip (RTL8821, RTL8822)', 'RTL8822CE', 'RTL8821CE');
fam('wireless-module', 'Realtek', 'RTL87', 2, 2, 'Wi-Fi and Bluetooth chip (RTL8723)', 'RTL8723BE', 'RTL8723DE');
// ---- Memory -----------------------------------------------------------------------------------------------------------
fam('spi-flash', 'Winbond', 'W25Q', 2, 3, 'serial NOR flash (W25Q64, W25Q128)', 'W25Q64FVSSIG', 'W25Q128JVSQ', 'W25Q32JVSSIQ', 'W25Q80DVSNIG');
fam('spi-flash', 'Winbond', 'W25X', 2, 2, 'serial NOR flash (W25X40)', 'W25X40CLSNIG', 'W25X20');
fam('spi-flash', 'Macronix', 'MX25L', 3, 5, 'serial NOR flash (MX25L6406E, MX25L12835F)', 'MX25L6406EM2I-12G', 'MX25L12835FM2I-10G', 'MX25L1606E');
fam('spi-flash', 'Macronix', 'MX25U', 3, 5, 'low-voltage serial NOR flash (MX25U6435F)', 'MX25U6435FM2I-10G', 'MX25U12835F');
fam('spi-flash', 'GigaDevice', 'GD25Q', 2, 3, 'serial NOR flash (GD25Q64, GD25Q128)', 'GD25Q64CSIG', 'GD25Q128CSIG', 'GD25Q32');
fam('spi-flash', 'EON', 'EN25Q', 2, 3, 'serial NOR flash (EN25Q64, EN25Q80)', 'EN25Q64-104HIP', 'EN25Q80A');
fam('spi-flash', 'XTX', 'XT25F', 2, 3, 'serial NOR flash (XT25F64, XT25F128)', 'XT25F64BSSIGU', 'XT25F128B');
fam('spi-flash', 'Boya', 'BY25Q', 2, 3, 'serial NOR flash (BY25Q64, BY25Q128)', 'BY25Q64ASSIG', 'BY25Q128ES');
fam('spi-flash', 'Fudan', 'FM25Q', 2, 3, 'serial NOR flash (FM25Q64, FM25Q128)', 'FM25Q64-SOB-T-G', 'FM25Q128A');
pre('spi-flash', 'Micron', 'N25Q', 'serial NOR flash family', 'N25Q128A13ESE40E', 'N25Q064A13ESE40F');
pre('spi-flash', 'Micron', 'MT25Q', 'serial NOR flash family', 'MT25QL128ABA1ESE-0SIT', 'MT25QU256ABA8E12-0SIT');
pre('spi-flash', 'Spansion', 'S25FL', 'serial NOR flash family', 'S25FL128SAGMFIR01', 'S25FL064L');
fam('eeprom', 'Atmel', 'AT24C', 2, 4, 'two-wire serial EEPROM (AT24C02, AT24C256)', 'AT24C02C-SSHM-T', 'AT24C256C-SSHL-T', 'AT24C08');
fam('eeprom', 'Microchip', '24LC', 2, 3, 'I2C serial EEPROM (24LC02, 24LC256)', '24LC256-I/SN', '24LC02B-I/SN');
fam('eeprom', 'Microchip', '24AA', 2, 3, 'I2C serial EEPROM (24AA02, 24AA256)', '24AA256-I/SN', '24AA02E48T-I/OT');
fam('eeprom', 'STMicroelectronics', 'M24C', 2, 2, 'I2C serial EEPROM (M24C02, M24C64)', 'M24C02-WMN6TP', 'M24C64-RMN6TP');
fam('eeprom', 'onsemi', 'CAT24C', 2, 3, 'I2C serial EEPROM (CAT24C02, CAT24C256)', 'CAT24C256WI-GT3', 'CAT24C02WI-GT3');
fam('eeprom', 'Microchip', '93C', 2, 2, 'Microwire serial EEPROM (93C46, 93C66)', '93C46B-I/SN', '93C66');
pre('eeprom', 'Rohm', 'BR24', 'I2C serial EEPROM family', 'BR24G256FJ-3GTE2', 'BR24T02FVT-WE2');
pre('dram', 'Micron', 'MT41K', 'DDR3L SDRAM', 'MT41K256M16HA-125:E', 'MT41K128M16JT-125');
pre('dram', 'Micron', 'MT41J', 'DDR3 SDRAM', 'MT41J256M16HA-15E:D', 'MT41J128M16');
pre('dram', 'Micron', 'MT40A', 'DDR4 SDRAM', 'MT40A512M16LY-075:E', 'MT40A256M16');
pre('dram', 'Micron', 'MT53', 'LPDDR4 and LPDDR4X SDRAM', 'MT53E256M32D2DS-053', 'MT53D512M32D2DS');
pre('dram', 'Micron', 'MT52L', 'LPDDR3 SDRAM', 'MT52L256M32D1PF-107');
pre('dram', 'Samsung', 'K4A', 'DDR4 SDRAM', 'K4A8G165WC-BCTD', 'K4A4G165WF-BCTD');
pre('dram', 'Samsung', 'K4B', 'DDR3 SDRAM', 'K4B4G1646E-BYK0', 'K4B2G1646F-BYK0');
pre('dram', 'Samsung', 'K4E', 'LPDDR3 SDRAM', 'K4E6E304EE-EGCF', 'K4E8E324EB-EGCF');
pre('dram', 'Samsung', 'K4F', 'LPDDR4 SDRAM', 'K4F6E304HB-MGCJ', 'K4F8E3S4HD-MHCL');
pre('dram', 'Samsung', 'K4U', 'LPDDR4X SDRAM', 'K4U6E3S4AA-MGCL');
pre('dram', 'Samsung', 'K4G', 'GDDR5 graphics SDRAM', 'K4G80325FB-HC25', 'K4G41325FE-HC28');
pre('dram', 'Samsung', 'K4Z', 'GDDR6 graphics SDRAM', 'K4Z80325BC-HC14');
pre('dram', 'SK hynix', 'H5AN', 'DDR4 SDRAM', 'H5AN8G6NAFR-UHC', 'H5AN4G6NBJR-UHC');
pre('dram', 'SK hynix', 'H5TC', 'DDR3 SDRAM', 'H5TC4G63CFR-PBA', 'H5TC2G63FFR-PBA');
pre('dram', 'SK hynix', 'H5TQ', 'DDR3 SDRAM', 'H5TQ4G63AFR-PBC', 'H5TQ2G63DFR-H9C');
pre('dram', 'SK hynix', 'H5GQ', 'GDDR5 graphics SDRAM', 'H5GQ2H24AFR-R2C', 'H5GQ1H24AFR-T2C');
pre('dram', 'SK hynix', 'H5GC', 'GDDR5 graphics SDRAM', 'H5GC8H24MJR-R0C');
pre('dram', 'SK hynix', 'H9H', 'LPDDR4 SDRAM', 'H9HCNNNBPUMLHR-NLE', 'H9HKNNNBTUMLXR-NMH');
pre('dram', 'ISSI', 'IS43', 'DDR3 and DDR4 SDRAM', 'IS43TR16256A-107MBLI', 'IS43DR16320D');
pre('dram', 'ISSI', 'IS46', 'DDR3 and DDR4 SDRAM, automotive and industrial grades', 'IS46TR16256A-107MBLA');
pre('dram', 'Winbond', 'W631', 'DDR3 SDRAM', 'W631GG6KB-15', 'W631GG6MB-12');
pre('dram', 'Nanya', 'NT5', 'DDR2, DDR3 and DDR4 SDRAM', 'NT5CC256M16ER-EK', 'NT5AD512M16C4-JR');
pre('nand-emmc-ufs', 'Samsung', 'KLM', 'eMMC flash storage', 'KLMAG1JETD-B041', 'KLMBG2JENB-B041');
pre('nand-emmc-ufs', 'Samsung', 'KLU', 'UFS flash storage', 'KLUBG4G1CE-B0B1', 'KLUDG8J1CB-B0B1');
pre('nand-emmc-ufs', 'Samsung', 'K9F', 'NAND flash memory', 'K9F1G08U0E-SCB0');
pre('nand-emmc-ufs', 'SK hynix', 'H26M', 'eMMC flash storage', 'H26M64003DQR', 'H26M52208FPR');
pre('nand-emmc-ufs', 'Micron', 'MTFC', 'eMMC flash storage', 'MTFC8GAKAJCN-4M', 'MTFC16GAPALBH-IT');
pre('nand-emmc-ufs', 'Micron', 'MT29F', 'NAND flash memory', 'MT29F2G08ABAEAWP-IT:E', 'MT29F4G08ABADAWP');
pre('nand-emmc-ufs', 'Toshiba', 'THGB', 'eMMC flash storage', 'THGBMNG5D1LBAIL', 'THGBMDG5D1LBAIL');
pre('nand-emmc-ufs', 'Toshiba', 'THGJ', 'UFS flash storage', 'THGJFAT0T43BAIL');
pre('nand-emmc-ufs', 'Toshiba', 'TC58', 'NAND flash memory', 'TC58NVG1S3HBAI4', 'TC58NVG2S0HBAI4');
// ---- Clocks and oscillators ----------------------------------------------------------------------------------------
pre('clock-gen', 'Renesas', 'ICS9', 'notebook clock generator family', 'ICS9LPRS355BKLFT', 'ICS9LPR363');
pre('clock-gen', 'Pericom', 'PI6C', 'clock generator and buffer family', 'PI6C557-05BLE', 'PI6C49S1510');
pre('clock-gen', 'Texas Instruments', 'CDCE', 'programmable clock generator family', 'CDCE937PW', 'CDCE949PWR');
one('clock-gen', 'Silicon Labs', 'SI5351', 'I2C-programmable clock generator', 'SI5351A-B-GT', 'SI5351C-B-GM');
fam('oscillator', 'SiTime', 'SIT8', 3, 3, 'MEMS oscillator (SiT8008, SiT8009)', 'SIT8008BI-23-33E-25.000000', 'SIT8009AI');
// ---- Discrete semiconductors ---------------------------------------------------------------------------------------
one('mosfet-n', 'Nexperia', '2N7002', 'N-channel small-signal MOSFET', '2N7002', '2N7002K', '2N7002LT1G');
one('mosfet-n', 'onsemi', 'BSS138', 'N-channel small-signal MOSFET', 'BSS138', 'BSS138LT1G', 'BSS138W');
one('mosfet-n', 'Alpha and Omega', 'AO3400', 'N-channel MOSFET, SOT-23', 'AO3400', 'AO3400A');
one('mosfet-n', 'Vishay', 'SI2302', 'N-channel MOSFET, SOT-23', 'SI2302CDS-T1-GE3', 'SI2302DS');
fam('mosfet-n', 'Infineon', 'BSC', 3, 4, 'OptiMOS N-channel power MOSFET, SuperSO8 (BSC014N04LS)', 'BSC014N04LS', 'BSC052N03LS', 'BSC093N04LSG');
fam('mosfet-n', 'Infineon', 'BSZ', 3, 4, 'OptiMOS N-channel power MOSFET, PQFN 3x3 (BSZ0902NS)', 'BSZ0902NS', 'BSZ097N04LS');
fam('mosfet-n', 'Texas Instruments', 'CSD17', 3, 3, 'N-channel NexFET power MOSFET, 30 V (CSD17575Q3)', 'CSD17575Q3', 'CSD17570Q5B');
fam('mosfet-n', 'Texas Instruments', 'CSD18', 3, 3, 'N-channel NexFET power MOSFET, 40 V and 60 V (CSD18534Q5A)', 'CSD18534Q5A', 'CSD18537NQ5A');
fam('mosfet-n', 'Texas Instruments', 'CSD19', 3, 3, 'N-channel NexFET power MOSFET, 80 V and 100 V (CSD19531Q5A)', 'CSD19531Q5A', 'CSD19533Q5A');
pre('mosfet-n', 'Toshiba', 'SSM3K', 'N-channel small-signal MOSFET', 'SSM3K15FU', 'SSM3K56CT');
fam('mosfet-n', 'Diodes Incorporated', 'DMN', 3, 4, 'N-channel MOSFET (DMN2004, DMN3404)', 'DMN3404L-7', 'DMN2004K-7', 'DMN6040SVT');
one('mosfet-p', 'Alpha and Omega', 'AO3401', 'P-channel MOSFET, SOT-23', 'AO3401', 'AO3401A');
one('mosfet-p', 'Alpha and Omega', 'AO4407', 'P-channel MOSFET, SO-8', 'AO4407', 'AO4407A');
one('mosfet-p', 'Alpha and Omega', 'AO4435', 'P-channel MOSFET, SO-8', 'AO4435', 'AO4435L');
one('mosfet-p', 'Vishay', 'SI2301', 'P-channel MOSFET, SOT-23', 'SI2301CDS-T1-GE3', 'SI2301DS');
one('mosfet-p', 'Vishay', 'SI2305', 'P-channel MOSFET, SOT-23', 'SI2305CDS-T1-GE3', 'SI2305DS');
fam('mosfet-p', 'Texas Instruments', 'CSD25', 3, 3, 'P-channel NexFET power MOSFET (CSD25402Q3A)', 'CSD25402Q3A', 'CSD25404Q3');
pre('mosfet-p', 'Toshiba', 'SSM3J', 'P-channel small-signal MOSFET', 'SSM3J332R', 'SSM3J15FU');
fam('mosfet-p', 'Diodes Incorporated', 'DMP', 3, 4, 'P-channel MOSFET (DMP2305, DMP3099)', 'DMP2305U-7', 'DMP3099L-7');
one('mosfet-dual', 'Alpha and Omega', 'AO4800', 'dual N-channel MOSFET, SO-8', 'AO4800', 'AO4800B');
one('mosfet-dual', 'Alpha and Omega', 'AO4606', 'complementary N- and P-channel MOSFET pair, SO-8', 'AO4606', 'AO4606L');
one('mosfet-dual', 'Fortune', 'FS8205', 'dual N-channel MOSFET for battery protection', 'FS8205A', 'FS8205');
one('mosfet-dual', 'Various', '8205', 'dual N-channel MOSFET for battery protection, generic part number', '8205A', '8205B');
fam('bjt', 'Nexperia', 'BC8', 2, 2, 'small-signal bipolar transistors (BC846 to BC860)', 'BC847B', 'BC857C', 'BC817-25');
fam('bjt', 'Nexperia', 'BC3', 2, 2, 'general-purpose bipolar transistors (BC327, BC337)', 'BC337-40', 'BC327-25');
fam('bjt', 'onsemi', 'MMBT', 4, 4, 'SOT-23 bipolar transistors (MMBT3904, MMBT3906)', 'MMBT3904', 'MMBT3906LT1G', 'MMBT2222A');
one('bjt', 'onsemi', '2N3904', 'NPN general-purpose bipolar transistor', '2N3904', '2N3904BU');
one('bjt', 'onsemi', '2N3906', 'PNP general-purpose bipolar transistor', '2N3906', '2N3906BU');
one('bjt', 'onsemi', '2N2222', 'NPN general-purpose bipolar transistor', '2N2222A', '2N2222');
one('bjt', 'Sanyo', 'S8050', 'NPN general-purpose bipolar transistor', 'S8050', 'S8050-D');
one('bjt', 'Sanyo', 'S8550', 'PNP general-purpose bipolar transistor', 'S8550', 'S8550-D');
one('diode', 'onsemi', '1N4148', 'small-signal switching diode', '1N4148', '1N4148WS', '1N4148W-7-F');
one('diode', 'onsemi', '1N4007', 'general-purpose rectifier diode', '1N4007', '1N4007-T');
one('diode', 'Nexperia', 'BAV99', 'dual high-speed switching diode', 'BAV99', 'BAV99LT1G', 'BAV99W');
one('diode', 'Nexperia', 'BAS16', 'high-speed switching diode', 'BAS16', 'BAS16LT1G');
pre('diode', 'Nexperia', 'BZX84', 'zener diode, SOT-23', 'BZX84-C5V1', 'BZX84C3V3');
fam('diode', 'Diodes Incorporated', 'MMSZ', 4, 4, 'zener diode, SOD-123 (MMSZ4678)', 'MMSZ5231B', 'MMSZ4678-7-F');
fam('schottky', 'Panjit', 'SS', 2, 3, 'surface-mount Schottky rectifier (SS14, SS34, SS54)', 'SS14', 'SS34-13-F', 'SS110');
fam('schottky', 'onsemi', '1N581', 1, 1, 'Schottky rectifier (1N5817 to 1N5819)', '1N5819', '1N5817', '1N5819HW');
fam('schottky', 'onsemi', '1N582', 1, 1, 'Schottky rectifier (1N5820 to 1N5822)', '1N5822', '1N5820');
fam('schottky', 'onsemi', 'MBR', 3, 4, 'Schottky power rectifier (MBR0520, MBR340)', 'MBR0520LT1G', 'MBR340', 'MBR2045CT');
one('schottky', 'Nexperia', 'BAT54', 'small-signal Schottky diode', 'BAT54', 'BAT54S', 'BAT54C');
pre('schottky', 'Nexperia', 'PMEG', 'low-forward-voltage Schottky rectifier family', 'PMEG3010EP', 'PMEG6020ER');
pre('tvs-esd', 'Texas Instruments', 'TPD', 'ESD protection diode family', 'TPD4E004DRYR', 'TPD2E001DRLR');
pre('tvs-esd', 'Nexperia', 'PESD', 'ESD protection diode family', 'PESD5V0S1BL', 'PESD3V3L1BA');
pre('tvs-esd', 'Nexperia', 'PRTR5V', 'ESD protection for high-speed interfaces', 'PRTR5V0U2X', 'PRTR5V0U4D');
pre('tvs-esd', 'STMicroelectronics', 'USBLC6', 'ESD protection for USB', 'USBLC6-2SC6', 'USBLC6-4SC6');
pre('tvs-esd', 'Semtech', 'RCLAMP', 'low-capacitance TVS array', 'RCLAMP0524P', 'RCLAMP3374N');
pre('tvs-esd', 'Littelfuse', 'SMAJ', 'surface-mount TVS diode, 400 W', 'SMAJ5.0A', 'SMAJ24CA');
pre('tvs-esd', 'Littelfuse', 'SMBJ', 'surface-mount TVS diode, 600 W', 'SMBJ24A', 'SMBJ5.0CA');
pre('tvs-esd', 'Littelfuse', 'SMCJ', 'surface-mount TVS diode, 1500 W', 'SMCJ24A', 'SMCJ12CA');
// ---- Level shifters, logic ------------------------------------------------------------------------------------------
one('level-shifter', 'NXP', 'PCA9306', 'dual bidirectional I2C level translator', 'PCA9306DCUR', 'PCA9306');
one('level-shifter', 'NXP', 'PCA9517', 'level-translating I2C bus repeater', 'PCA9517ADP', 'PCA9517');
fam('level-shifter', 'Texas Instruments', 'TXB01', 2, 2, 'bidirectional level translator with auto direction sensing (TXB0104, TXB0108)', 'TXB0108PWR', 'TXB0104RUTR', 'TXB0102DCUR');
fam('level-shifter', 'Texas Instruments', 'TXS01', 2, 2, 'bidirectional level translator, open-drain compatible (TXS0102, TXS0108)', 'TXS0108EPWR', 'TXS0102DCUR');
fam('level-shifter', 'Nexperia', 'NTB01', 2, 2, 'bidirectional level translator (NTB0101, NTB0104)', 'NTB0104BQ', 'NTB0102GT');
fam('level-shifter', 'Texas Instruments', 'SN74LVC1T', 2, 2, 'single-bit dual-supply bus transceiver and level translator (SN74LVC1T45)', 'SN74LVC1T45DBVR', 'SN74LVC1T45DCKR');
pre('level-shifter', 'Texas Instruments', 'SN74AVC', 'dual-supply bus transceiver and level translator family', 'SN74AVC4T774RSVR', 'SN74AVC8T245PW');
fam('logic', 'Texas Instruments', 'SN74LVC1G', 2, 3, 'single-gate logic (SN74LVC1G08, SN74LVC1G125)', 'SN74LVC1G08DBVR', 'SN74LVC1G125DCKR', 'SN74LVC1G14DBVR');
fam('logic', 'Texas Instruments', 'SN74LVC2G', 2, 3, 'dual-gate logic (SN74LVC2G14, SN74LVC2G07)', 'SN74LVC2G14DBVR', 'SN74LVC2G07DBVR');
fam('logic', 'Texas Instruments', 'SN74AHC1G', 2, 3, 'single-gate logic (SN74AHC1G08)', 'SN74AHC1G08DBVR', 'SN74AHC1G14DBVR');
fam('logic', 'Texas Instruments', 'SN74AUP1G', 2, 3, 'low-power single-gate logic (SN74AUP1G04)', 'SN74AUP1G04DCKR', 'SN74AUP1G08DCKR');
fam('logic', 'Texas Instruments', 'SN74HC', 2, 3, 'high-speed CMOS logic (SN74HC595, SN74HC04)', 'SN74HC595DR', 'SN74HC04N', 'SN74HC245PWR');
fam('logic', 'Nexperia', '74HC', 2, 3, 'high-speed CMOS logic (74HC595, 74HC04)', '74HC595D', '74HC04D', '74HC245PW');
fam('logic', 'Nexperia', '74HCT', 2, 3, 'high-speed CMOS logic with TTL levels (74HCT245)', '74HCT245D', '74HCT04PW');
fam('logic', 'Nexperia', '74LVC', 2, 3, 'low-voltage CMOS logic (74LVC245, 74LVC1G08)', '74LVC245APW', '74LVC14AD');
fam('logic', 'Nexperia', '74AHC', 2, 3, 'advanced high-speed CMOS logic (74AHC1G08, 74AHC245)', '74AHC245PW', '74AHC14D');
fam('logic', 'Texas Instruments', 'CD40', 2, 2, 'CMOS logic (CD4017, CD4051)', 'CD4017BE', 'CD4051BM');
fam('logic', 'NXP', 'PCA95', 2, 2, 'I2C and SMBus I/O expanders and multiplexers (PCA9555, PCA9548)', 'PCA9555PW', 'PCA9548APW');
fam('logic', 'Silicon Labs', 'SLG46', 3, 3, 'programmable mixed-signal logic (SLG46140)', 'SLG46140V', 'SLG46531V');
// ---- Analog: amplifiers, comparators, references, supervisors, sensing ---------------------------------------------------
one('opamp-comparator', 'Texas Instruments', 'LM358', 'dual operational amplifier', 'LM358DR', 'LM358', 'LM358N');
one('opamp-comparator', 'Texas Instruments', 'LM324', 'quad operational amplifier', 'LM324DR', 'LM324N');
one('opamp-comparator', 'Texas Instruments', 'LM393', 'dual comparator', 'LM393DR', 'LM393', 'LM393DT');
one('opamp-comparator', 'Texas Instruments', 'LM339', 'quad comparator', 'LM339DR', 'LM339N');
one('opamp-comparator', 'Texas Instruments', 'LM2904', 'dual operational amplifier', 'LM2904DR', 'LM2904');
fam('opamp-comparator', 'Texas Instruments', 'TL07', 1, 1, 'low-noise JFET-input operational amplifier (TL072, TL074)', 'TL072CDR', 'TL074CN', 'TL071');
fam('opamp-comparator', 'Texas Instruments', 'OPA', 3, 4, 'operational amplifier family (OPA2134, OPA1612)', 'OPA2134UA', 'OPA1612AIDR', 'OPA350');
fam('opamp-comparator', 'Texas Instruments', 'LMV3', 2, 2, 'low-voltage operational amplifier and comparator (LMV321, LMV358, LMV393)', 'LMV321IDBVR', 'LMV358IDR', 'LMV393IDR');
fam('opamp-comparator', 'Microchip', 'MCP600', 1, 1, 'operational amplifier (MCP6001)', 'MCP6001T-I/OT', 'MCP6002-I/SN');
fam('current-sense', 'Texas Instruments', 'INA2', 2, 2, 'digital power and current monitor (INA219, INA226)', 'INA219AIDCNR', 'INA226AIDGSR');
fam('current-sense', 'Texas Instruments', 'INA18', 1, 1, 'current-sense amplifier (INA180, INA181)', 'INA180A1IDBVR', 'INA181A1IDBVR');
one('current-sense', 'Allegro', 'ACS712', 'Hall-effect current sensor', 'ACS712ELCTR-05B-T', 'ACS712');
one('voltage-reference', 'Texas Instruments', 'TL431', 'adjustable shunt regulator', 'TL431ACDBZR', 'TL431', 'TL431BIDBZR');
one('voltage-reference', 'Texas Instruments', 'TLV431', 'low-voltage adjustable shunt regulator', 'TLV431ACDBZR', 'TLV431');
one('voltage-reference', 'Texas Instruments', 'LM4040', 'precision micropower shunt voltage reference', 'LM4040AIM3-2.5', 'LM4040');
one('voltage-reference', 'Diodes Incorporated', 'AZ431', 'adjustable shunt regulator', 'AZ431AN-ATRE1', 'AZ431');
fam('supervisor', 'Texas Instruments', 'TPS38', 2, 2, 'voltage supervisor and reset generator (TPS3808, TPS3823)', 'TPS3808G33DBVR', 'TPS3823-33DBVR');
fam('supervisor', 'Diodes Incorporated', 'APX80', 1, 1, 'voltage supervisor (APX803, APX809)', 'APX803-31SAG-7', 'APX809-29SAG');
one('supervisor', 'Maxim', 'MAX809', 'microprocessor supervisor', 'MAX809SEUR+T', 'MAX809');
one('supervisor', 'Maxim', 'MAX811', 'microprocessor supervisor with manual reset', 'MAX811SEUS+T', 'MAX811');
one('supervisor', 'Texas Instruments', 'TLV803', 'voltage supervisor', 'TLV803EA29DBZR', 'TLV803');
// ---- Sensors, fan control ----------------------------------------------------------------------------------------------
fam('sensor', 'Texas Instruments', 'TMP', 2, 3, 'digital temperature sensor (TMP75, TMP102)', 'TMP102AIDRLR', 'TMP75AIDR', 'TMP117');
fam('sensor', 'Texas Instruments', 'LM75', 0, 1, 'digital temperature sensor (LM75, LM75A)', 'LM75BIM-3', 'LM75AIM');
one('sensor', 'Texas Instruments', 'LM35', 'precision analog temperature sensor', 'LM35DZ', 'LM35');
one('sensor', 'Maxim', 'DS18B20', 'one-wire digital thermometer', 'DS18B20+', 'DS18B20Z');
fam('sensor', 'Bosch', 'BMA', 3, 3, 'digital accelerometer (BMA250, BMA280)', 'BMA250', 'BMA280');
fam('sensor', 'Bosch', 'BMI', 3, 3, 'inertial measurement unit (BMI160, BMI270)', 'BMI160', 'BMI270');
fam('sensor', 'Bosch', 'BME', 3, 3, 'environmental sensor (BME280)', 'BME280', 'BME680');
fam('sensor', 'Bosch', 'BMP', 3, 3, 'barometric pressure sensor (BMP280)', 'BMP280', 'BMP388');
fam('sensor', 'InvenSense', 'MPU', 4, 4, 'motion tracking device (MPU6050, MPU9250)', 'MPU6050', 'MPU9250');
pre('sensor', 'STMicroelectronics', 'LSM6', 'inertial module family', 'LSM6DS3TR-C', 'LSM6DSOTR');
pre('sensor', 'STMicroelectronics', 'LIS3', 'MEMS accelerometer family', 'LIS3DHTR', 'LIS3MDLTR');
fam('sensor', 'Sensirion', 'SHT3', 1, 1, 'humidity and temperature sensor (SHT31)', 'SHT31-DIS-B', 'SHT30-DIS');
fam('fan-ctl', 'Microchip', 'EMC21', 2, 2, 'fan controller with temperature sensing (EMC2101, EMC2103)', 'EMC2101-ACZL-TR', 'EMC2103-1-AIZL');
fam('fan-ctl', 'Maxim', 'MAX665', 1, 1, 'fan controller (MAX6650, MAX6651)', 'MAX6650EEE+', 'MAX6651EUA');
fam('fan-ctl', 'Analog Devices', 'ADT74', 2, 2, 'thermal and fan controller (ADT7473, ADT7475)', 'ADT7473ARQZ', 'ADT7475ARQZ');
// ---- Processors and microcontrollers ----------------------------------------------------------------------------------
fam('soc-cpu-gpu', 'Qualcomm', 'SDM', 3, 3, 'Snapdragon system on chip (SDM845, SDM660)', 'SDM845', 'SDM660');
fam('soc-cpu-gpu', 'Qualcomm', 'SM8', 3, 3, 'Snapdragon system on chip (SM8150, SM8250)', 'SM8150', 'SM8250');
fam('soc-cpu-gpu', 'Qualcomm', 'MSM8', 3, 3, 'Snapdragon system on chip (MSM8996)', 'MSM8996', 'MSM8953');
fam('soc-cpu-gpu', 'Qualcomm', 'APQ8', 3, 3, 'Snapdragon application processor (APQ8084)', 'APQ8084', 'APQ8064');
fam('soc-cpu-gpu', 'MediaTek', 'MT67', 2, 2, 'Helio system on chip (MT6765, MT6771)', 'MT6765', 'MT6771V');
fam('soc-cpu-gpu', 'MediaTek', 'MT68', 2, 2, 'Dimensity system on chip (MT6833, MT6877)', 'MT6833', 'MT6877V');
fam('soc-cpu-gpu', 'Rockchip', 'RK3', 3, 3, 'application processor (RK3288, RK3399)', 'RK3288', 'RK3399');
pre('mcu', 'STMicroelectronics', 'STM32', 'Arm Cortex-M microcontroller family', 'STM32F103C8T6', 'STM32L476RGT6');
pre('mcu', 'Atmel', 'ATMEGA', 'AVR microcontroller family', 'ATMEGA328P-AU', 'ATMEGA2560-16AU');
pre('mcu', 'Atmel', 'ATTINY', 'AVR microcontroller family', 'ATTINY85-20SU', 'ATTINY13A-SU');
pre('mcu', 'Microchip', 'PIC1', 'PIC microcontroller family', 'PIC16F877A-I/P', 'PIC18F4550-I/PT');
pre('mcu', 'Texas Instruments', 'MSP430', 'ultra-low-power microcontroller family', 'MSP430G2553IPW20', 'MSP430F5529IPN');
pre('mcu', 'Espressif', 'ESP32', 'Wi-Fi and Bluetooth microcontroller family', 'ESP32-WROOM-32', 'ESP32-S3');

/** All families, longest stem first (the most specific family wins). */
export const PART_FAMILIES: readonly PartFamily[] = ROWS.slice().sort((a, b) => b.stem.length - a.stem.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function partFamilyById(id: string): PartFamily | undefined {
  return PART_FAMILIES.find(family => family.id === id);
}
