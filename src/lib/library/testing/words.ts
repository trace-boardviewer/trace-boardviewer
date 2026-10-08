/*
 * The fixed word lists of the synthetic library. Every vendor, model and part-number prefix here is invented (plant, bird and
 * place words, made-up compounds): no real manufacturer, ODM, product line or part family. Changing a list changes every
 * generated library, so the lists are part of the generator version (GENERATOR_VERSION in ground-truth.ts).
 */

export const VENDORS: readonly string[] = [
  'Alder', 'Birchfield', 'Kestrel', 'Larkspur', 'Mossgate', 'Nettleby', 'Oakhollow', 'Pennyroyal', 'Quillon', 'Rowanbrook',
  'Sedgemoor', 'Thistledown', 'Umberfield', 'Willowmere', 'Yarrowby', 'Zephyrcote', 'Ashgrove', 'Brindlewood', 'Cobblestay', 'Dunmere',
  'Elmsworth', 'Fernhollow', 'Gorsefield', 'Hazelmoor', 'Ivywell', 'Juniperby', 'Knollbridge', 'Lindenmoor', 'Marshwick', 'Nightjar',
  'Orchardby', 'Plumbury', 'Quarrybank', 'Reedmoor', 'Saltmarsh', 'Tanglewood', 'Upperthorn', 'Violetby', 'Wrenfield', 'Yewdale',
];

export const MODEL_WORDS: readonly string[] = [
  'Heron', 'Plover', 'Wren', 'Lapwing', 'Curlew', 'Teal', 'Dunlin', 'Skylark', 'Bittern', 'Linnet', 'Redshank', 'Whimbrel',
  'Godwit', 'Shoveler', 'Pochard', 'Fieldfare', 'Redwing', 'Siskin', 'Twite', 'Goldcrest', 'Nuthatch', 'Chiffchaff', 'Corncrake', 'Stonechat',
  'Wagtail', 'Pipit', 'Brambling', 'Dipper', 'Kittiwake', 'Fulmar', 'Gannet', 'Shearwater', 'Avocet', 'Ruff', 'Snipe', 'Knot',
];

export const MODEL_SUFFIXES: readonly string[] = ['Air', 'Pro', 'Mini', 'Plus', 'Lite', 'Max', 'S', 'X', 'Go', 'One', 'Duo', 'Edge'];
export const MODEL_NUMBERS: readonly string[] = ['11', '12', '13', '14', '15', '16', '17', '2', '3', '4', '5', '7', '9', '100', '200', '310', '420', '550'];

export type DeviceType = 'laptop' | 'phone' | 'tablet' | 'console' | 'graphics' | 'monitor' | 'desktop' | 'mainboard';
export const DEVICE_TYPES: readonly DeviceType[] = ['laptop', 'phone', 'tablet', 'console', 'graphics', 'monitor', 'desktop', 'mainboard'];

/** Device words by interface language; a library names its folders in whichever of them the technician happened to use. */
export const DEVICE_WORDS: Readonly<Record<DeviceType, readonly string[]>> = {
  laptop: ['Laptop', 'Notebook', 'laptop', 'noteszgép', 'ordinateur portable', 'portatile', 'prenosný počítač', 'ноутбук'],
  phone: ['Phone', 'Smartphone', 'telefon', 'Handy', 'téléphone', 'telefono', 'telefón', 'телефон'],
  tablet: ['Tablet', 'tablet', 'Tablet-PC', 'tablette', 'tavoletta'],
  console: ['Console', 'konzol', 'Konsole', 'console de jeux', 'konsola', 'консоль'],
  graphics: ['GPU', 'Graphics', 'VGA card', 'grafikus kártya', 'Grafikkarte', 'carte graphique', 'scheda video', 'karta graficzna'],
  monitor: ['Monitor', 'TV', 'monitor', 'Fernseher', 'téléviseur', 'telewizor'],
  desktop: ['Desktop', 'asztali gép', 'Tower', 'PC desktop', 'komputer stacjonarny'],
  mainboard: ['Motherboard', 'Mainboard', 'alaplap', 'Hauptplatine', 'carte mère', 'scheda madre', 'základná doska', 'płyta główna', 'материнська плата'],
};

/** Words the technicians put in file names for each role (ASCII only, so a PDF title block can reuse them). */
export const ROLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  board: ['boardview', 'board', 'brd', 'layout', 'pcb', 'mainboard', 'bv', 'viewer file'],
  schematic: ['schematic', 'schematics', 'sch', 'circuit diagram', 'schema', 'rajz', 'kapcsolasi rajz'],
  'board-pdf': ['boardview pdf', 'pcb layout', 'assembly', 'board photo layout'],
  datasheet: ['datasheet', 'ds', 'data sheet', 'specification'],
  'service-manual': ['service manual', 'manual', 'disassembly', 'repair guide', 'maintenance'],
  bom: ['bom', 'parts list', 'bill of materials'],
  photo: ['photo', 'board top', 'board bottom', 'front', 'back'],
  firmware: ['bios', 'ec', 'dump', 'flash', 'firmware', 'rom'],
};

export const FOLDER_WORDS: readonly string[] = [
  'Boardview', 'Schematics', 'Datasheets', 'BIOS', 'Manuals', 'Photos', 'Old', 'New folder', 'Backup', 'To sort', 'Downloads', 'Misc', 'Stuff', 'Drive D', 'Work', 'Customers', 'Repair files',
];

/** Names that carry no information: the technician's "final_v2" files and camera dumps. */
export const OPAQUE_STEMS: readonly string[] = [
  'board_final_v2', 'new', 'New Document', 'scan', 'untitled', 'file', 'download', 'document', 'IMG', 'DSC', 'final', 'schem', 'bv', 'data', 'copy of new', 'doc1', 'temp', 'misc', 'backup',
];

/** Prefixes of the invented IC part numbers (three letters, no real family). */
export const MPN_PREFIXES: readonly string[] = ['QXM', 'VLR', 'ZTN', 'HBQ', 'DWX', 'MZP', 'RJT', 'NYS', 'FCL', 'GPQ', 'XDB', 'WTV', 'BNZ', 'CRZ', 'JLD', 'SVH'];
export const MPN_SUFFIXES: readonly string[] = ['XQR', 'LTR', 'BRZ', 'PKR', 'WNR', 'ZDT', 'HGA'];
/** Lead-free and reel markers that a normaliser may strip (the "base" of a part number). */
export const MPN_MARKERS: readonly string[] = ['/NOPB', '#PBF', '-PBF', '-TR', '/TR', '-REEL'];

export const PROSE_NOUNS: readonly string[] = [
  'cover', 'screw', 'battery', 'connector', 'ribbon cable', 'fan', 'heatsink', 'keyboard', 'bracket', 'speaker', 'hinge', 'display panel', 'adhesive strip', 'shield can', 'antenna lead', 'daughter board',
];
export const PROSE_VERBS: readonly string[] = [
  'Remove', 'Loosen', 'Disconnect', 'Lift', 'Peel back', 'Slide out', 'Unclip', 'Inspect', 'Replace', 'Reseat', 'Secure', 'Clean',
];
export const PROSE_PLACES: readonly string[] = [
  'the left side', 'the lower edge', 'the top of the board', 'the rear panel', 'the hinge area', 'the right side', 'the centre of the chassis', 'the front rim',
];
export const PROSE_HEADINGS: readonly string[] = [
  'Disassembly', 'Troubleshooting', 'Removing the battery', 'Replacing the fan', 'Power-on checks', 'Display problems', 'Keyboard removal', 'Reassembly', 'Safety notes', 'Tools needed',
];

export const BUSES: readonly string[] = ['I2C', 'SPI', 'UART', 'USB', 'PCIE', 'DDR', 'LCD', 'GPIO', 'EC', 'SD', 'HDMI', 'AUD', 'CLK', 'RST', 'PWR', 'TP'];
export const BUS_SIGNALS: readonly string[] = ['SDA', 'SCL', 'CLK', 'MOSI', 'MISO', 'CS', 'TX', 'RX', 'DP', 'DM', 'D0', 'D1', 'D2', 'D3', 'EN', 'INT', 'RESET'];
export const RAIL_STYLES: readonly string[] = ['pp', 'plus', 'vcc', 'num', 'vdd'];
