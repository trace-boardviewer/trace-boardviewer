import { describe, expect, it } from 'vitest';
import { deviceTypeHints, documentTypeForExtension, documentTypeHints, extensionOf, summarizeHints, vendorById, vendorHints } from './hints';
import { DEVICES, DEVICE_TYPES, DOCUMENTS, DOCUMENT_TYPES, VENDORS } from './lexicon';
import { lexiconKey } from './chars';

const topVendor = (text: string) => summarizeHints(vendorHints(text))[0]?.id;
const topDevice = (text: string) => summarizeHints(deviceTypeHints(text))[0]?.id;
const topDocument = (text: string) => summarizeHints(documentTypeHints(text))[0]?.id;

describe('vendor hints', () => {
  const rows: Array<[string, string]> = [
    ['Apple MacBook', 'apple'], ['MacBookPro11,1', 'apple'], ['MacBookAir7', 'apple'], ['iPhone 12', 'apple'], ['iPad Air', 'apple'], ['iMac 27', 'apple'], ['Mac mini', 'apple'], ['mac pro', 'apple'], ['MacMini', 'apple'], ['mac a1466', 'apple'],
    ['Dell Inspiron 15', 'dell'], ['Latitude E7470', 'dell'], ['XPS 13', 'dell'], ['Optiplex 7010', 'dell'], ['Alienware m15', 'dell'], ['Vostro 3500', 'dell'],
    ['HP EliteBook 840', 'hp'], ['Hewlett-Packard', 'hp'], ['Hewlett Packard', 'hp'], ['ProBook 450', 'hp'], ['Pavilion dv6', 'hp'], ['ZBook 15', 'hp'], ['HP', 'hp'], ['Compaq Presario', 'hp'],
    ['Lenovo T480', 'lenovo'], ['ThinkPad T480', 'lenovo'], ['IdeaPad 3', 'lenovo'], ['ThinkBook 14', 'lenovo'], ['ThinkCentre M920', 'lenovo'],
    ['ASUS X540', 'asus'], ['ASUSTeK', 'asus'], ['ZenBook UX305', 'asus'], ['VivoBook S15', 'asus'], ['ROG Strix', 'asus'], ['TUF Gaming', 'asus'],
    ['Acer E5-575', 'acer'], ['Aspire 5', 'acer'], ['TravelMate P2', 'acer'], ['MSI GL63', 'msi'], ['Micro-Star', 'msi'], ['micro star', 'msi'],
    ['Samsung NP900', 'samsung'], ['Galaxy S21', 'samsung'], ['GalaxyBook Pro', 'samsung'], ['Sony Vaio', 'sony'], ['PlayStation 4', 'sony'], ['Xperia Z3', 'sony'],
    ['Toshiba Tecra', 'toshiba'], ['Dynabook', 'toshiba'], ['Portege Z30', 'toshiba'], ['Fujitsu Lifebook', 'fujitsu'], ['Esprimo P720', 'fujitsu'],
    ['Microsoft Surface Pro 7', 'microsoft'], ['Surface Laptop 3', 'microsoft'], ['Xbox One', 'microsoft'], ['Huawei MateBook', 'huawei'], ['Honor MagicBook', 'honor'], ['Xiaomi Redmi Note', 'xiaomi'], ['Redmi 9', 'xiaomi'],
    ['Oppo Reno', 'oppo'], ['Vivo Y20', 'vivo'], ['OnePlus 9', 'oneplus'], ['Google Pixel', 'google'], ['Motorola', 'motorola'], ['Nokia 3310', 'nokia'], ['LGE', 'lg'], ['LG G6', 'lg'],
    ['Panasonic Toughbook', 'panasonic'], ['Razer Blade', 'razer'], ['Gigabyte Aorus', 'gigabyte'], ['ASRock B450', 'asrock'], ['EVGA GTX', 'evga'], ['Nintendo Switch', 'nintendo'], ['Steam Deck', 'valve'], ['SteamDeck', 'valve'],
    ['NVIDIA GeForce', 'nvidia'], ['GeForce GTX 1060', 'nvidia'], ['AMD Radeon', 'amd'], ['Radeon RX 580', 'amd'], ['Ryzen 5', 'amd'], ['Intel NUC', 'intel'],
    ['Compal', 'compal'], ['Quanta', 'quanta'], ['Wistron', 'wistron'], ['Inventec', 'inventec'], ['Pegatron', 'pegatron'], ['Foxconn', 'foxconn'], ['Hon Hai', 'foxconn'], ['HonHai', 'foxconn'], ['LCFC', 'lcfc'], ['Clevo', 'clevo'],
    ['Wingtech', 'wingtech'], ['Huaqin', 'huaqin'], ['Longcheer', 'longcheer'], ['Arima', 'arima'], ['Kinpo', 'kinpo'],
  ];
  it('has many vendors', () => {
    expect(rows.length).toBeGreaterThanOrEqual(90);
  });
  it.each(rows)('%j is %s', (text, id) => {
    expect(topVendor(text)).toBe(id);
  });
  const none = ['', '   ', 'resistor 10K', 'board', 'surface mount', 'surface mount footprints', 'precision', 'valve', 'moto', 'pixel', 'legion', 'yoga', 'nexus', 'poco', 'satellite', 'transformer', 'honorary', 'intelligent', 'amdahl', 'sonyx',
    'applex', 'dellx', 'xdell', 'hpx', 'xhp', 'lenovox', 'asuss'];
  it.each(none)('finds no vendor in %j', text => {
    expect(vendorHints(text).map(hint => hint.id)).toEqual([]);
  });
  it('rates the vendor name above a product line above a weak word', () => {
    expect(vendorHints('Dell')[0].confidence).toBe(90);
    expect(vendorHints('Compal')[0].confidence).toBe(85);
    expect(vendorHints('Latitude')[0].confidence).toBe(65);
    expect(vendorHints('HP')[0].confidence).toBe(55);
    expect(vendorHints('HP')[0].basis).toBe('weak');
    expect(vendorHints('Latitude')[0].basis).toBe('line');
    expect(vendorHints('Compal')[0].kind).toBe('odm');
    expect(vendorHints('Dell')[0].kind).toBe('brand');
    expect(vendorHints('NVIDIA')[0].kind).toBe('chip-maker');
  });
  it('gives the span of the match in the text', () => {
    const text = 'Folder Dell Latitude E7470 by Compal';
    const hints = vendorHints(text);
    expect(hints.map(hint => text.slice(hint.start, hint.end))).toEqual(['Dell', 'Latitude', 'Compal']);
  });
  it('adds a little for each further hint of the same vendor', () => {
    expect(summarizeHints(vendorHints('Dell Latitude'))[0]).toEqual({ id: 'dell', confidence: 93, count: 2 });
    expect(summarizeHints(vendorHints('Dell Dell Dell Dell Dell Dell'))[0].confidence).toBe(99);
  });
  it('ranks different vendors by confidence', () => {
    const ranked = summarizeHints(vendorHints('Compal board for Lenovo ThinkPad'));
    expect(ranked.map(item => item.id)).toEqual(['lenovo', 'compal']);
  });
  it('finds the vendor entry by id', () => {
    expect(vendorById('apple')?.name).toBe('Apple');
    expect(vendorById('nobody')).toBeUndefined();
  });
});

describe('device type hints, in the eight interface languages', () => {
  const rows: Array<[string, string]> = [
    // English
    ['laptop', 'laptop'], ['Notebook', 'laptop'], ['netbook', 'laptop'], ['Ultrabook', 'laptop'], ['Chromebook', 'laptop'], ['MacBook Pro', 'laptop'], ['ThinkPad T480', 'laptop'], ['EliteBook', 'laptop'], ['ZenBook', 'laptop'],
    ['phone', 'phone'], ['smartphone', 'phone'], ['cellphone', 'phone'], ['handset', 'phone'], ['iPhone 11', 'phone'], ['Xperia', 'phone'], ['tablet', 'tablet'], ['Tablet PC', 'tablet'], ['iPad', 'tablet'],
    ['motherboard', 'desktop-board'], ['mainboard', 'desktop-board'], ['mobo', 'desktop-board'], ['ATX', 'desktop-board'], ['mATX', 'desktop-board'], ['mini-ITX', 'desktop-board'], ['desktop board', 'desktop-board'], ['desktop', 'desktop-board'],
    ['all in one', 'all-in-one'], ['all-in-one', 'all-in-one'], ['iMac', 'all-in-one'], ['GPU', 'gpu'], ['graphics card', 'gpu'], ['video card', 'gpu'], ['RTX 3060', 'gpu'], ['GTX1060', 'gpu'], ['GeForce', 'gpu'], ['Radeon RX', 'gpu'],
    ['console', 'console'], ['PS4', 'console'], ['PS5', 'console'], ['PS3', 'console'], ['PSP', 'console'], ['Xbox', 'console'], ['PlayStation', 'console'], ['Nintendo', 'console'], ['Steam Deck', 'console'],
    ['monitor', 'monitor'], ['TV', 'monitor'], ['television', 'monitor'], ['LCD TV', 'monitor'], ['LED TV', 'monitor'], ['PSU', 'psu'], ['power supply', 'psu'],
    // Hungarian
    ['telefon', 'phone'], ['okostelefon', 'phone'], ['mobiltelefon', 'phone'], ['alaplap', 'desktop-board'], ['táblagép', 'tablet'], ['videokártya', 'gpu'], ['grafikus kártya', 'gpu'], ['konzol', 'console'], ['tápegység', 'psu'],
    // German
    ['Notebook', 'laptop'], ['Handy', 'phone'], ['Hauptplatine', 'desktop-board'], ['Grafikkarte', 'gpu'], ['Videokarte', 'gpu'], ['Konsole', 'console'], ['Fernseher', 'monitor'], ['Netzteil', 'psu'],
    // French
    ['ordinateur portable', 'laptop'], ['PC portable', 'laptop'], ['téléphone', 'phone'], ['tablette', 'tablet'], ['carte mère', 'desktop-board'], ['carte graphique', 'gpu'], ['console de jeux', 'console'], ['alimentation', 'psu'],
    // Italian
    ['portatile', 'laptop'], ['telefono', 'phone'], ['cellulare', 'phone'], ['scheda madre', 'desktop-board'], ['scheda video', 'gpu'], ['televisore', 'monitor'], ['alimentatore', 'psu'],
    // Slovak
    ['prenosný počítač', 'laptop'], ['telefón', 'phone'], ['základná doska', 'desktop-board'], ['grafická karta', 'gpu'], ['konzola', 'console'], ['televízor', 'monitor'], ['zdroj', 'psu'],
    // Polish
    ['smartfon', 'phone'], ['płyta główna', 'desktop-board'], ['karta graficzna', 'gpu'], ['konsola', 'console'], ['telewizor', 'monitor'], ['zasilacz', 'psu'], ['laptopy', 'laptop'],
    // Ukrainian
    ['ноутбук', 'laptop'], ['смартфон', 'phone'], ['телефон', 'phone'], ['мобільний телефон', 'phone'], ['планшет', 'tablet'], ['материнська плата', 'desktop-board'], ['відеокарта', 'gpu'], ['консоль', 'console'], ['телевізор', 'monitor'], ['блок живлення', 'psu'],
  ];
  it('has many words', () => {
    expect(rows.length).toBeGreaterThanOrEqual(100);
  });
  it.each(rows)('%j is %s', (text, id) => {
    expect(topDevice(text)).toBe(id);
  });
  const none = ['', 'resistor', 'board', 'schematic', 'phonetic', 'laptopsy', 'tabletop', 'consolex', 'tvx', 'xtv', 'monitoring', 'atxx', 'gpux', 'psus', 'desktops', 'notebooks'];
  it.each(none)('finds no device type in %j', text => {
    expect(deviceTypeHints(text).map(hint => hint.id)).toEqual([]);
  });
  it('rates the laptop word above the word for any motherboard', () => {
    expect(deviceTypeHints('laptop')[0].confidence).toBe(80);
    expect(deviceTypeHints('motherboard')[0].confidence).toBe(50);
    expect(deviceTypeHints('motherboard')[0].basis).toBe('weak');
    expect(deviceTypeHints('ATX')[0].confidence).toBe(80);
    expect(deviceTypeHints('MacBook')[0].confidence).toBe(65);
    expect(deviceTypeHints('Handy')[0].confidence).toBe(50);
  });
  it('reads a phrase as one hint and not as its parts', () => {
    expect(deviceTypeHints('ordinateur portable').map(hint => hint.id)).toEqual(['laptop']);
    expect(deviceTypeHints('mobil telefon').map(hint => hint.id)).toEqual(['phone', 'phone']);
    expect(deviceTypeHints('all in one').map(hint => hint.id)).toEqual(['all-in-one']);
    expect(deviceTypeHints('Steam Deck').map(hint => hint.id)).toEqual(['console']);
  });
  it('joins the words of a phrase by a blank, a dash, an underscore or a dot', () => {
    for (const glue of [' ', '-', '_', '.']) expect(deviceTypeHints(`graphics${glue}card`).map(hint => hint.id)).toEqual(['gpu']);
    expect(deviceTypeHints('graphics  card').map(hint => hint.id)).toEqual([]);
    expect(deviceTypeHints('graphics, card').map(hint => hint.id)).toEqual([]);
  });
  it('reads the leading letters of a word that ends in digits', () => {
    expect(deviceTypeHints('RTX3060').map(hint => hint.id)).toEqual(['gpu']);
    expect(deviceTypeHints('MacBookPro11').map(hint => hint.id)).toEqual(['laptop']);
    expect(deviceTypeHints('ThinkPadX1').map(hint => hint.id)).toEqual(['laptop']);
  });
  it('knows every device type of the lexicon', () => {
    expect(DEVICES.map(entry => entry.id)).toEqual([...DEVICE_TYPES]);
  });
});

describe('document type hints', () => {
  const rows: Array<[string, string]> = [
    ['schematic', 'schematic'], ['Schematics', 'schematic'], ['schematic diagram', 'schematic'], ['circuit diagram', 'schematic'], ['electrical diagram', 'schematic'], ['sch', 'schematic'],
    ['Schaltplan', 'schematic'], ['schéma', 'schematic'], ['schemat', 'schematic'], ['schema', 'schematic'], ['схема', 'schematic'], ['kapcsolási rajz', 'schematic'], ['schematy', 'schematic'],
    ['boardview', 'board'], ['board view', 'board'], ['BoardViewer', 'board'], ['brd', 'board'],
    ['assembly drawing', 'board-pdf'], ['pcb layout', 'board-pdf'], ['placement drawing', 'board-pdf'], ['component placement', 'board-pdf'],
    ['datasheet', 'datasheet'], ['Datasheets', 'datasheet'], ['Data Sheet', 'datasheet'], ['Datenblatt', 'datasheet'], ['fiche technique', 'datasheet'], ['scheda tecnica', 'datasheet'], ['adatlap', 'datasheet'],
    ['katalógový list', 'datasheet'], ['karta katalogowa', 'datasheet'], ['даташит', 'datasheet'],
    ['service manual', 'service-manual'], ['ServiceManual', 'service-manual'], ['repair manual', 'service-manual'], ['repair guide', 'service-manual'], ['disassembly', 'service-manual'], ['Hardware Maintenance Manual', 'service-manual'],
    ['Servicehandbuch', 'service-manual'], ['manuel de service', 'service-manual'], ['manuale di servizio', 'service-manual'], ['instrukcja serwisowa', 'service-manual'], ['szerviz kézikönyv', 'service-manual'], ['szervizkézikönyv', 'service-manual'],
    ['servisná príručka', 'service-manual'], ['сервісний посібник', 'service-manual'], ['manual', 'service-manual'],
    ['BOM', 'bom'], ['bill of materials', 'bom'], ['parts list', 'bom'], ['partslist', 'bom'], ['Stückliste', 'bom'], ['nomenclature', 'bom'], ['distinta base', 'bom'], ['kusovník', 'bom'], ['anyagjegyzék', 'bom'], ['специфікація', 'bom'],
    ['photo', 'photo'], ['Photos', 'photo'], ['foto', 'photo'], ['fotka', 'photo'], ['image', 'photo'], ['IMG', 'photo'], ['thermal', 'thermal'], ['thermogram', 'thermal'], ['hőkamera', 'thermal'], ['Wärmebild', 'thermal'], ['FLIR', 'thermal'],
    ['BIOS', 'firmware'], ['firmware', 'firmware'], ['UEFI', 'firmware'], ['EC firmware', 'firmware'], ['eeprom', 'firmware'], ['spi', 'firmware'],
  ];
  it('has many words', () => {
    expect(rows.length).toBeGreaterThanOrEqual(70);
  });
  it.each(rows)('%j is %s', (text, id) => {
    expect(topDocument(text)).toBe(id);
  });
  const extensions: Array<[string, string | undefined]> = [
    ['x.brd', 'board'], ['x.BRD', 'board'], ['x.bdv', 'board'], ['x.bvr', 'board'], ['x.bv', 'board'], ['x.fz', 'board'], ['x.cad', 'board'], ['x.tvw', 'board'], ['x.cst', 'board'], ['x.asc', 'board'], ['x.xzz', 'board'], ['x.pcb', 'board'],
    ['x.pcbdoc', 'board'], ['x.kicad_pcb', 'board'], ['x.brd2', 'board'], ['x.sch', 'schematic'], ['x.schdoc', 'schematic'], ['x.kicad_sch', 'schematic'], ['x.dsn', 'schematic'],
    ['x.jpg', 'photo'], ['x.JPEG', 'photo'], ['x.png', 'photo'], ['x.bmp', 'photo'], ['x.tif', 'photo'], ['x.heic', 'photo'], ['x.webp', 'photo'], ['x.gif', 'photo'],
    ['x.rom', 'firmware'], ['x.cap', 'firmware'], ['x.fd', 'firmware'], ['x.bio', 'firmware'], ['x.bin', 'firmware'], ['x.csv', 'bom'], ['x.xls', 'bom'], ['x.xlsx', 'bom'],
    ['x.pdf', undefined], ['x.zip', undefined], ['x.txt', undefined], ['x', undefined], ['x.', undefined], ['.brd', undefined], ['Repair/x.brd', 'board'], ['C:\\boards\\x.bvr', 'board'],
  ];
  it.each(extensions)('the extension of %j suggests %s', (name, id) => {
    expect(documentTypeHints(name).find(hint => hint.basis === 'extension' || hint.basis === 'weak-extension')?.id).toBe(id);
  });
  it('rates an extension above a word and a weak extension below it', () => {
    expect(documentTypeForExtension('brd')).toMatchObject({ id: 'board', confidence: 85, basis: 'extension' });
    expect(documentTypeForExtension('.XLSX')).toMatchObject({ id: 'bom', confidence: 35, basis: 'weak-extension' });
    expect(documentTypeForExtension('pdf')).toBeUndefined();
    expect(documentTypeForExtension('x'.repeat(40))).toBeUndefined();
    expect(documentTypeForExtension(5 as unknown as string)).toBeUndefined();
  });
  it('takes the extension from the options when the name has none', () => {
    expect(documentTypeHints('MacBook 820-01234', { extension: 'brd' }).map(hint => hint.id)).toEqual(['board']);
    expect(documentTypeHints('MacBook schematic', { extension: 'pdf' }).map(hint => hint.id)).toEqual(['schematic']);
  });
  it('reads the extension of a name', () => {
    const rows2: Array<[string, string]> = [['a.brd', 'brd'], ['A.BRD', 'brd'], ['a.b.c', 'c'], ['a', ''], ['a.', ''], ['.a', ''], ['dir/a.b', 'b'], ['dir.x/a', ''], ['dir\\a.b', 'b'], ['', ''], ['a.' + 'x'.repeat(20), '']];
    for (const [name, extension] of rows2) expect(extensionOf(name), name).toBe(extension);
    expect(extensionOf(5 as unknown as string)).toBe('');
  });
  it('knows every document type of the lexicon', () => {
    expect(DOCUMENTS.map(entry => entry.id)).toEqual([...DOCUMENT_TYPES]);
  });
  it('combines a word and an extension', () => {
    const summary = summarizeHints(documentTypeHints('iPhone schematic.pdf'));
    expect(summary.map(item => item.id)).toEqual(['schematic']);
    const both = summarizeHints(documentTypeHints('boardview x.brd'));
    expect(both[0]).toEqual({ id: 'board', confidence: 91, count: 3 });
  });
});

describe('lexicon integrity', () => {
  const words = (entry: { words: readonly string[]; weak?: readonly string[]; lines?: readonly string[] }) => [...entry.words, ...(entry.weak ?? []), ...(entry.lines ?? [])];
  it('writes every word in its folded form or a form that folds to a key', () => {
    for (const entry of [...VENDORS, ...DEVICES, ...DOCUMENTS]) for (const word of words(entry)) {
      expect(word.trim(), `${entry.id}: ${word}`).toBe(word);
      expect(word.length, `${entry.id}: ${word}`).toBeGreaterThan(1);
      expect(lexiconKey(word).length, `${entry.id}: ${word}`).toBeGreaterThan(1);
      expect(word.split(/[\s\-_.]+/).length, `${entry.id}: ${word}`).toBeLessThanOrEqual(3);
    }
  });
  it('never gives one word to two different ids within a lexicon', () => {
    for (const entries of [VENDORS, DEVICES, DOCUMENTS] as ReadonlyArray<ReadonlyArray<{ id: string; words: readonly string[]; weak?: readonly string[]; lines?: readonly string[] }>>) {
      const owner = new Map<string, string>();
      for (const entry of entries) for (const word of words(entry)) {
        const key = lexiconKey(word).replace(/[\s\-_.]+/g, ' ');
        const known = owner.get(key);
        expect(known === undefined || known === entry.id, `${key}: ${known} and ${entry.id}`).toBe(true);
        owner.set(key, entry.id);
      }
    }
  });
  it('has unique ids and at least one word per entry', () => {
    for (const entries of [VENDORS, DEVICES, DOCUMENTS] as ReadonlyArray<ReadonlyArray<{ id: string; words: readonly string[] }>>) {
      expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    }
    for (const entry of VENDORS) expect(entry.words.length + (entry.lines?.length ?? 0) + (entry.weak?.length ?? 0), entry.id).toBeGreaterThan(0);
  });
  it('covers each of the eight interface languages for the phone, the board and the schematic', () => {
    const phone: Record<string, string> = { hu: 'telefon', en: 'phone', de: 'Mobiltelefon', fr: 'téléphone', it: 'telefono', sk: 'telefón', pl: 'smartfon', uk: 'телефон' };
    const board: Record<string, string> = { hu: 'alaplap', en: 'motherboard', de: 'Hauptplatine', fr: 'carte mère', it: 'scheda madre', sk: 'základná doska', pl: 'płyta główna', uk: 'материнська плата' };
    const schematic: Record<string, string> = { hu: 'kapcsolási rajz', en: 'schematic', de: 'Schaltplan', fr: 'schéma', it: 'schema', sk: 'schéma', pl: 'schemat', uk: 'схема' };
    for (const language of Object.keys(phone)) {
      expect(topDevice(phone[language]), `phone ${language}`).toBe('phone');
      expect(topDevice(board[language]), `board ${language}`).toBe('desktop-board');
      expect(topDocument(schematic[language]), `schematic ${language}`).toBe('schematic');
    }
  });
  it('is marked CC0', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('./lexicon.ts', import.meta.url), 'utf8').slice(0, 600)).toContain('CC0 1.0');
  });
});

describe('hints: bounds', () => {
  it('give nothing for input that is not text', () => {
    for (const value of [undefined, null, 5, {}, [], Symbol('x')] as unknown[]) {
      expect(vendorHints(value as string)).toEqual([]);
      expect(deviceTypeHints(value as string)).toEqual([]);
      expect(documentTypeHints(value as string)).toEqual([]);
    }
  });
  it('stop at the maximum number of results', () => {
    const text = Array.from({ length: 2000 }, () => 'laptop').join(' ');
    expect(deviceTypeHints(text).length).toBeLessThanOrEqual(256);
  });
  it('skip a very long word', () => {
    expect(deviceTypeHints(`${'x'.repeat(5000)} laptop`).map(hint => hint.id)).toEqual(['laptop']);
  });
  it('count a bounded number of steps per character', () => {
    const meter = { steps: 0 };
    const text = 'Dell Latitude laptop schematic.pdf '.repeat(100);
    vendorHints(text, { meter });
    deviceTypeHints(text, { meter });
    expect(meter.steps).toBeLessThanOrEqual(6 * text.length);
  });
});
