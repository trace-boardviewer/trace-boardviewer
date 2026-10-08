/**
 * Word lists of the Library's recognition: vendors, device types and document types.
 *
 * Licence: CC0 1.0 (public domain dedication). The lists are common words and brand names used nominatively, written by the
 * developers of this application; nothing is copied from a catalogue, a vendor document or another product.
 *
 * Words are matched against the alphanumeric runs of a text, lower-cased with the accents removed (`lexiconKey`), so
 * "Tápegység" and "tapegyseg" are the same word. A phrase has up to three words separated by one blank, "-" or "_".
 * Entries are written in plain lower case; the engine folds them the same way it folds the text.
 *
 * Eight interface languages (hu, en, de, fr, it, sk, pl, uk) are covered for device and document types. Where a word
 * belongs to several things ("portable" is a laptop in one language and a phone in another; "display" is a monitor and a
 * phone part) it is left out or given a low confidence.
 */

export type VendorKind = 'brand' | 'odm' | 'chip-maker';

export interface VendorEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: VendorKind;
  /** The vendor's own names. */
  readonly words: readonly string[];
  /** Words for a vendor name too short or too common to trust (two letters). */
  readonly weak?: readonly string[];
  /** Product-line words that imply the vendor with less certainty; a word that starts with one of the stems matches too. */
  readonly lines?: readonly string[];
}

export const VENDORS: readonly VendorEntry[] = [
  { id: 'apple', name: 'Apple', kind: 'brand', words: ['apple'], lines: ['mac', 'macbook', 'imac', 'iphone', 'ipad', 'macmini', 'mac mini', 'airpods', 'macpro', 'mac pro', 'applewatch'] },
  { id: 'dell', name: 'Dell', kind: 'brand', words: ['dell'], lines: ['latitude', 'inspiron', 'optiplex', 'vostro', 'alienware', 'xps'] },
  { id: 'hp', name: 'HP', kind: 'brand', words: ['hewlett packard', 'hewlett-packard'], weak: ['hp'], lines: ['elitebook', 'probook', 'pavilion', 'zbook', 'omen', 'spectre', 'compaq'] },
  { id: 'lenovo', name: 'Lenovo', kind: 'brand', words: ['lenovo'], lines: ['thinkpad', 'ideapad', 'thinkcentre', 'thinkbook'] },
  { id: 'asus', name: 'ASUS', kind: 'brand', words: ['asus', 'asustek'], lines: ['zenbook', 'vivobook', 'rog', 'tuf', 'zenfone'] },
  { id: 'acer', name: 'Acer', kind: 'brand', words: ['acer'], lines: ['aspire', 'travelmate'] },
  { id: 'msi', name: 'MSI', kind: 'brand', words: ['msi', 'micro-star'] },
  { id: 'samsung', name: 'Samsung', kind: 'brand', words: ['samsung'], lines: ['galaxy', 'galaxybook'] },
  { id: 'sony', name: 'Sony', kind: 'brand', words: ['sony'], lines: ['vaio', 'playstation', 'xperia'] },
  { id: 'toshiba', name: 'Toshiba', kind: 'brand', words: ['toshiba', 'dynabook'], lines: ['tecra', 'portege'] },
  { id: 'fujitsu', name: 'Fujitsu', kind: 'brand', words: ['fujitsu'], lines: ['lifebook', 'esprimo'] },
  { id: 'microsoft', name: 'Microsoft', kind: 'brand', words: ['microsoft'], lines: ['surface pro', 'surface laptop', 'surface book', 'surface go', 'xbox'] },
  { id: 'huawei', name: 'Huawei', kind: 'brand', words: ['huawei'], lines: ['matebook'] },
  { id: 'honor', name: 'Honor', kind: 'brand', words: ['honor'], lines: ['magicbook'] },
  { id: 'xiaomi', name: 'Xiaomi', kind: 'brand', words: ['xiaomi'], lines: ['redmi'] },
  { id: 'oppo', name: 'Oppo', kind: 'brand', words: ['oppo'] },
  { id: 'vivo', name: 'Vivo', kind: 'brand', words: ['vivo'] },
  { id: 'oneplus', name: 'OnePlus', kind: 'brand', words: ['oneplus'] },
  { id: 'google', name: 'Google', kind: 'brand', words: ['google'] },
  { id: 'motorola', name: 'Motorola', kind: 'brand', words: ['motorola'] },
  { id: 'nokia', name: 'Nokia', kind: 'brand', words: ['nokia'] },
  { id: 'lg', name: 'LG', kind: 'brand', words: ['lge'], weak: ['lg'] },
  { id: 'panasonic', name: 'Panasonic', kind: 'brand', words: ['panasonic'], lines: ['toughbook'] },
  { id: 'razer', name: 'Razer', kind: 'brand', words: ['razer'] },
  { id: 'gigabyte', name: 'Gigabyte', kind: 'brand', words: ['gigabyte'], lines: ['aorus'] },
  { id: 'asrock', name: 'ASRock', kind: 'brand', words: ['asrock'] },
  { id: 'evga', name: 'EVGA', kind: 'brand', words: ['evga'] },
  { id: 'nintendo', name: 'Nintendo', kind: 'brand', words: ['nintendo'], lines: ['gameboy'] },
  { id: 'valve', name: 'Valve', kind: 'brand', words: ['steam deck', 'steamdeck'] },
  { id: 'nvidia', name: 'NVIDIA', kind: 'chip-maker', words: ['nvidia'], lines: ['geforce'] },
  { id: 'amd', name: 'AMD', kind: 'chip-maker', words: ['amd'], lines: ['radeon', 'ryzen'] },
  { id: 'intel', name: 'Intel', kind: 'chip-maker', words: ['intel'] },
  { id: 'compal', name: 'Compal', kind: 'odm', words: ['compal'] },
  { id: 'quanta', name: 'Quanta', kind: 'odm', words: ['quanta'] },
  { id: 'wistron', name: 'Wistron', kind: 'odm', words: ['wistron'] },
  { id: 'inventec', name: 'Inventec', kind: 'odm', words: ['inventec'] },
  { id: 'pegatron', name: 'Pegatron', kind: 'odm', words: ['pegatron'] },
  { id: 'foxconn', name: 'Foxconn', kind: 'odm', words: ['foxconn', 'hon hai', 'honhai'] },
  { id: 'lcfc', name: 'LCFC', kind: 'odm', words: ['lcfc'] },
  { id: 'clevo', name: 'Clevo', kind: 'odm', words: ['clevo'] },
  { id: 'wingtech', name: 'Wingtech', kind: 'odm', words: ['wingtech'] },
  { id: 'huaqin', name: 'Huaqin', kind: 'odm', words: ['huaqin'] },
  { id: 'longcheer', name: 'Longcheer', kind: 'odm', words: ['longcheer'] },
  { id: 'arima', name: 'Arima', kind: 'odm', words: ['arima'] },
  { id: 'kinpo', name: 'Kinpo', kind: 'odm', words: ['kinpo'] },
];

export type DeviceType = 'laptop' | 'phone' | 'tablet' | 'desktop-board' | 'all-in-one' | 'gpu' | 'console' | 'monitor' | 'psu';

export const DEVICE_TYPES: readonly DeviceType[] = ['laptop', 'phone', 'tablet', 'desktop-board', 'all-in-one', 'gpu', 'console', 'monitor', 'psu'];

export interface DeviceEntry {
  readonly id: DeviceType;
  /** Words and phrases that name the device type, in the eight interface languages. */
  readonly words: readonly string[];
  /** Weak words: shared with other meanings. */
  readonly weak?: readonly string[];
  /** Product-line words that imply the device type; a word that starts with one of the stems matches too. */
  readonly lines?: readonly string[];
}

export const DEVICES: readonly DeviceEntry[] = [
  {
    id: 'laptop',
    words: ['laptop', 'notebook', 'netbook', 'ultrabook', 'chromebook', 'ordinateur portable', 'pc portable', 'portatile', 'prenosny pocitac', 'ноутбук', 'laptopy', 'notebooky'],
        lines: ['macbook', 'thinkpad', 'ideapad', 'latitude', 'elitebook', 'probook', 'zenbook', 'vivobook', 'travelmate', 'thinkbook', 'matebook', 'galaxybook', 'lifebook', 'toughbook'],
  },
  {
    id: 'phone',
    words: ['phone', 'smartphone', 'cellphone', 'handset', 'mobiltelefon', 'okostelefon', 'telefon', 'telephone', 'telefono', 'cellulare', 'smartfon', 'смартфон', 'телефон', 'мобільний телефон'],
    weak: ['mobile', 'mobil', 'handy'],
    lines: ['iphone', 'xperia', 'zenfone', 'redmi'],
  },
  { id: 'tablet', words: ['tablet', 'tablette', 'tablagep', 'планшет', 'tablet pc'], lines: ['ipad'] },
  {
    id: 'desktop-board',
    // "Motherboard" names the main board of a laptop as well, so those words are weak; only the desktop form factors are strong.
    words: ['atx', 'matx', 'mini itx', 'desktop board', 'desktop motherboard'],
    weak: ['motherboard', 'mainboard', 'mobo', 'alaplap', 'hauptplatine', 'carte mere', 'scheda madre', 'zakladna doska', 'płyta główna', 'материнська плата', 'desktop', 'itx'],
    lines: ['optiplex', 'esprimo', 'thinkcentre'],
  },
  { id: 'all-in-one', words: ['all in one', 'all-in-one'], weak: ['aio'], lines: ['imac'] },
  {
    id: 'gpu',
    words: ['gpu', 'graphics card', 'video card', 'videokarte', 'grafikkarte', 'carte graphique', 'scheda video', 'graficka karta', 'karta graficzna', 'відеокарта', 'videokartya', 'grafikus kartya', 'rtx', 'gtx'],
    weak: ['vga'],
    lines: ['geforce', 'radeon'],
  },
  {
    id: 'console',
    words: ['console', 'konzol', 'konsole', 'konzola', 'konsola', 'консоль', 'ps3', 'ps4', 'ps5', 'psp', 'xbox', 'playstation', 'nintendo', 'steam deck'],
    lines: ['playstation', 'gameboy'],
  },
  {
    id: 'monitor',
    words: ['monitor', 'tv', 'television', 'televizor', 'fernseher', 'televisore', 'telewizor', 'телевізор', 'lcd tv', 'led tv'],
  },
  {
    id: 'psu',
    words: ['psu', 'power supply', 'netzteil', 'alimentation', 'alimentatore', 'tapegyseg', 'zasilacz', 'zdroj', 'блок живлення'],
  },
];

export type DocumentType = 'board' | 'schematic' | 'board-pdf' | 'datasheet' | 'service-manual' | 'bom' | 'photo' | 'thermal' | 'firmware';

export const DOCUMENT_TYPES: readonly DocumentType[] = ['board', 'schematic', 'board-pdf', 'datasheet', 'service-manual', 'bom', 'photo', 'thermal', 'firmware'];

export interface DocumentEntry {
  readonly id: DocumentType;
  readonly words: readonly string[];
  readonly weak?: readonly string[];
  /** File-name extensions (lower case, without the dot) that suggest the type. */
  readonly extensions?: readonly string[];
  /** Extensions that suggest the type only weakly (a spreadsheet may or may not be a bill of materials). */
  readonly weakExtensions?: readonly string[];
}

export const DOCUMENTS: readonly DocumentEntry[] = [
  {
    id: 'board',
    words: ['boardview', 'board view', 'boardviewer', 'brd'],
    weak: ['bv'],
    extensions: ['brd', 'brd2', 'bdv', 'bvr', 'bv', 'fz', 'cad', 'tvw', 'cst', 'asc', 'xzz', 'pcb', 'pcbdoc', 'kicad_pcb'],
  },
  {
    id: 'schematic',
    words: ['schematic', 'schematics', 'schematic diagram', 'circuit diagram', 'electrical diagram', 'schaltplan', 'schema', 'schemat', 'схема', 'kapcsolasi rajz', 'schematy', 'sch'],
    weak: ['rajz', 'diagram'],
    extensions: ['sch', 'schdoc', 'kicad_sch', 'dsn'],
  },
  { id: 'board-pdf', words: ['assembly drawing', 'pcb layout', 'placement drawing', 'component placement'], weak: ['assembly', 'layout'] },
  {
    id: 'datasheet',
    words: ['datasheet', 'datasheets', 'data sheet', 'datenblatt', 'fiche technique', 'scheda tecnica', 'adatlap', 'katalogovy list', 'karta katalogowa', 'даташит'],
  },
  {
    id: 'service-manual',
    words: ['service manual', 'servicemanual', 'repair manual', 'repair guide', 'disassembly', 'hardware maintenance manual', 'servicehandbuch', 'manuel de service', 'manuale di servizio', 'instrukcja serwisowa', 'szerviz kezikonyv', 'szervizkezikonyv', 'servisna prirucka', 'сервісний посібник'],
    weak: ['manual'],
  },
  {
    id: 'bom',
    words: ['bom', 'bill of materials', 'parts list', 'partslist', 'stuckliste', 'nomenclature', 'distinta base', 'kusovnik', 'anyagjegyzek', 'специфікація'],
    weakExtensions: ['csv', 'xls', 'xlsx'],
  },
  { id: 'photo', words: ['photo', 'photos', 'foto', 'fotka'], weak: ['image', 'pic', 'img'], extensions: ['jpg', 'jpeg', 'png', 'bmp', 'tif', 'tiff', 'heic', 'webp', 'gif'] },
  { id: 'thermal', words: ['thermal', 'thermogram', 'hokamera', 'warmebild', 'wärmebild', 'flir'] },
  { id: 'firmware', words: ['bios', 'firmware', 'uefi', 'ec firmware'], weak: ['eeprom', 'spi'], extensions: ['rom', 'cap', 'fd', 'bio', 'bin'] },
];
