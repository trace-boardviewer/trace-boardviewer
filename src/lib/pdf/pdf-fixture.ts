/**
 * Minimal PDF 1.4 writer for tests and the browser harness only; the application never imports it.
 * It emits uncompressed objects with a correct cross-reference table: Helvetica text at explicit
 * positions, an optional grey raster XObject (a "scanned" page), a bookmark tree, raw annotation / page /
 * catalog entries (security tests put scripts and external links there) and, through the `encryption` hook,
 * standard-security-handler encryption of stream data (`rc4Encryption` below supplies RC4-40/MD5).
 */
export interface FixtureText { x: number; y: number; text: string; size?: number }
export interface FixturePage {
  width?: number; height?: number; rotate?: 0 | 90 | 180 | 270; texts?: FixtureText[]; image?: boolean;
  /** Dictionary bodies (without the << >>) of annotations, e.g. `/Type /Annot /Subtype /Link /Rect [0 0 9 9] /A << /S /URI /URI (https://x.invalid/) >>`. */
  annotations?: string[];
  /** Extra entries of the page dictionary, e.g. `/AA << /O << /S /JavaScript /JS (...) >> >>`. */
  pageExtra?: string;
}
export interface FixtureOutlineItem { title: string; page: number; children?: FixtureOutlineItem[] }
export interface FixtureEncryption {
  /** Body of the /Encrypt dictionary, e.g. `/Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <...> /U <...>`. */
  dictionary: string;
  /** Hex string used for both /ID entries. */
  id: string;
  encrypt(objectNumber: number, generation: number, data: Uint8Array): Uint8Array;
}
export interface FixtureOptions {
  pages: FixturePage[]; outline?: FixtureOutlineItem[]; encryption?: FixtureEncryption;
  /** Extra entries of the catalog dictionary, e.g. `/OpenAction << /S /JavaScript /JS (...) >>`. */
  catalogExtra?: string;
}

const encoder = new TextEncoder();
const ascii = (text: string) => encoder.encode(text);

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const literal = (text: string) => `(${text.replace(/[\\()]/g, match => `\\${match}`).replace(/[^\x20-\x7e]/g, char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`)})`;
const utf16Hex = (text: string) => `<FEFF${[...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`;

export function buildPdfFixture(options: FixtureOptions): Uint8Array {
  const objects: Uint8Array[][] = []; // index + 1 = object number
  const add = (body: string | Uint8Array[]): number => { objects.push(typeof body === 'string' ? [ascii(body)] : body); return objects.length; };
  const reserve = (): number => { objects.push([]); return objects.length; };
  const set = (number: number, body: string | Uint8Array[]) => { objects[number - 1] = typeof body === 'string' ? [ascii(body)] : body; };
  const stream = (number: number, dictionary: string, data: Uint8Array): Uint8Array[] => {
    const bytes = options.encryption ? options.encryption.encrypt(number, 0, data) : data;
    return [ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, ascii('\nendstream')];
  };

  const catalog = reserve();
  const pagesNode = reserve();
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const image = options.pages.some(page => page.image) ? reserve() : 0;
  if (image) set(image, stream(image, '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', Uint8Array.of(0x40, 0xc0, 0xc0, 0x40)));

  const pageNumbers: number[] = [];
  for (const page of options.pages) {
    const width = page.width ?? 612, height = page.height ?? 792;
    const content: string[] = [];
    for (const text of page.texts ?? []) content.push(`BT /F1 ${text.size ?? 12} Tf 1 0 0 1 ${text.x} ${text.y} Tm ${literal(text.text)} Tj ET`);
    if (page.image) content.push(`q ${width * 0.6} 0 0 ${height * 0.4} ${width * 0.2} ${height * 0.3} cm /Im1 Do Q`);
    const pageNumber = reserve();
    const contentNumber = add(stream(objects.length + 1, '', ascii(content.join('\n'))));
    const resources = `/Resources << /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >>`;
    set(pageNumber, `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 ${width} ${height}]${page.rotate ? ` /Rotate ${page.rotate}` : ''} ${resources} /Contents ${contentNumber} 0 R`
      + `${page.annotations?.length ? ` /Annots [${page.annotations.map(body => `<< ${body} >>`).join(' ')}]` : ''}${page.pageExtra ? ` ${page.pageExtra}` : ''} >>`);
    pageNumbers.push(pageNumber);
  }
  set(pagesNode, `<< /Type /Pages /Kids [${pageNumbers.map(number => `${number} 0 R`).join(' ')}] /Count ${pageNumbers.length} >>`);

  let outlines = 0;
  if (options.outline?.length) {
    outlines = reserve();
    const writeLevel = (items: FixtureOutlineItem[], parent: number): { first: number; last: number; count: number } => {
      const numbers = items.map(() => reserve());
      let count = numbers.length;
      items.forEach((item, i) => {
        const children = item.children?.length ? writeLevel(item.children, numbers[i]) : null;
        if (children) count += children.count;
        const target = pageNumbers[item.page - 1] ?? pageNumbers[0];
        set(numbers[i], `<< /Title ${utf16Hex(item.title)} /Parent ${parent} 0 R${i > 0 ? ` /Prev ${numbers[i - 1]} 0 R` : ''}${i < numbers.length - 1 ? ` /Next ${numbers[i + 1]} 0 R` : ''}`
          + `${children ? ` /First ${children.first} 0 R /Last ${children.last} 0 R /Count ${children.count}` : ''} /Dest [${target} 0 R /XYZ 0 792 0] >>`);
      });
      return { first: numbers[0], last: numbers[numbers.length - 1], count };
    };
    const level = writeLevel(options.outline, outlines);
    set(outlines, `<< /Type /Outlines /First ${level.first} 0 R /Last ${level.last} 0 R /Count ${level.count} >>`);
  }
  set(catalog, `<< /Type /Catalog /Pages ${pagesNode} 0 R${outlines ? ` /Outlines ${outlines} 0 R /PageMode /UseOutlines` : ''}${options.catalogExtra ? ` ${options.catalogExtra}` : ''} >>`);
  const encrypt = options.encryption ? add(`<< ${options.encryption.dictionary} >>`) : 0;

  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n%âãÏÓ\n')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const parts = [ascii(`${i + 1} 0 obj\n`), ...body, ascii('\nendobj\n')];
    for (const part of parts) { chunks.push(part); offset += part.length; }
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${options.encryption!.id}> <${options.encryption!.id}>]` : ''} >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(ascii(xref + trailer));
  return concat(chunks);
}

// ---- Standard security handler, revision 2 (RC4 40-bit), PDF 1.7 algorithms 3.1-3.4 ----------------------------------
// Dependency-free (the browser harness uses it too): a compact MD5 (RFC 1321) and RC4.
const md5Shift = (round: number, step: number) => [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]][round][step & 3];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Digest(...parts: Uint8Array[]): Uint8Array {
  const message = concat(parts);
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, (message.length * 8) >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor((message.length * 8) / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const mixed = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const index = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (mixed + a + MD5_K[i] + view.getUint32(offset + index * 4, true)) >>> 0;
      const shift = md5Shift(round, i);
      a = d; d = c; c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true));
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const PASSWORD_PAD = Uint8Array.of(0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a);
const toHex = (bytes: Uint8Array) => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
function padPassword(password: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const given = encoder.encode(password).subarray(0, 32);
  bytes.set(given);
  bytes.set(PASSWORD_PAD.subarray(0, 32 - given.length), given.length);
  return bytes;
}

/** RC4-40 encryption hook for `FixtureOptions.encryption`: the document opens with `userPassword` (no owner password is set). */
export function rc4Encryption(userPassword: string): FixtureEncryption {
  const id = md5Digest(encoder.encode('trace-fixture-id'));
  const permissions = -1;
  const ownerKey = md5Digest(padPassword(userPassword)).subarray(0, 5);
  const o = rc4(ownerKey, padPassword(userPassword));
  const pBytes = Uint8Array.of(permissions & 255, (permissions >> 8) & 255, (permissions >> 16) & 255, (permissions >>> 24) & 255);
  const key = md5Digest(padPassword(userPassword), o, pBytes, id).subarray(0, 5);
  const u = rc4(key, PASSWORD_PAD);
  return {
    dictionary: `/Filter /Standard /V 1 /R 2 /Length 40 /P ${permissions} /O <${toHex(o)}> /U <${toHex(u)}>`,
    id: toHex(id),
    encrypt: (number, generation, data) => {
      const objectKey = md5Digest(key, Uint8Array.of(number & 255, (number >> 8) & 255, (number >> 16) & 255, generation & 255, (generation >> 8) & 255)).subarray(0, 10);
      return rc4(objectKey, data);
    },
  };
}
