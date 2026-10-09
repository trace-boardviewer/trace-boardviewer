'use strict';

// Shared deterministic image-only PDF fixture for packaged OCR checks.
// Running this historical script directly now fails loudly; use packaged-functional-qa.cjs.
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');

function makeImageOnlyPdf(words = ['PU301', 'U10']) {
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [ROOT] }));
  const { createCanvas } = createRequire(path.join(pdfjsRoot, 'package.json'))('@napi-rs/canvas');
  const widthPt = 420, heightPt = 300, scale = 300 / 72;
  const width = Math.round(widthPt * scale), height = Math.round(heightPt * scale);
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
  context.fillStyle = '#000';
  words.forEach((word, index) => {
    context.font = `bold ${Math.round((word.toUpperCase() === 'U10' ? 42 : 24) * scale)}px Arial`;
    context.fillText(word.toUpperCase(), 30 * scale, (60 + index * 60) * scale);
  });
  const rgba = context.getImageData(0, 0, width, height).data, gray = Buffer.alloc(width * height);
  for (let index = 0; index < gray.length; index++) gray[index] = (rgba[index * 4] * 77 + rgba[index * 4 + 1] * 150 + rgba[index * 4 + 2] * 29) >> 8;
  const image = zlib.deflateSync(gray), content = Buffer.from(`q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im1 Do Q`);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [];
  let offset = chunks[0].length;
  objects.forEach((body, index) => { offsets.push(offset); const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]); chunks.push(part); offset += part.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

module.exports = Object.freeze({ makeImageOnlyPdf });

if (require.main === module) {
  console.error('Deprecated standalone OCR runner: use scripts/packaged-functional-qa.cjs with explicit package paths.');
  process.exitCode = 2;
}
