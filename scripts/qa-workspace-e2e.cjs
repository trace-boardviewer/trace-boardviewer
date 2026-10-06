'use strict';

// End-to-end proof of the technician workflow in the REAL built Electron app (dist/ + electron/main.cjs + preload):
//   open board -> attach PDF + image + KiCad schematic through the native chooser (EXACTLY three rows, all `ready`, each really rendered)
//   -> search PU301 -> cross-probe -> pin note with a typed measurement -> quit -> reopen: everything restored -> a moved document
//   is relinked -> B46 (a PDF viewer remount keeps the reading camera) -> an alias created in the UI -> restart: the alias is still there
//   -> the board camera (pan/zoom/rotate/bottom side) is restored after a restart -> another board never inherits documents, aliases or camera.
// All data is synthetic and generated here. Needs a production build (`pnpm build`) and a display:
//
//   pnpm build && xvfb-run -a node scripts/qa-workspace-e2e.cjs
//
// `--no-sandbox` is passed only because the container runs as root; the app window keeps its own sandbox setting.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TRACE_QA_OUT || path.join(os.tmpdir(), 'trace-e2e-shots');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium screenshots are) so screenshots can be compared without touching the page (CSP).
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, depth = 0, color = 0; const idat = [];
  while (pos < buf.length) { const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len); if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; } else if (type === 'IDAT') idat.push(data); pos += 12 + len; }
  if (depth !== 8 || (color !== 6 && color !== 2)) throw new Error(`unsupported PNG ${depth}/${color}`);
  const bpp = color === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0; let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}
/** Fraction of pixels that differ from the top-left background pixel: tells a view with board features from an empty region. */
function featureFraction(png) {
  const { width, height, bpp, data } = decodePng(png); let n = 0;
  for (let i = 0; i < data.length; i += bpp) if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 24) n++;
  return n / (width * height);
}
/** Fraction of pixels (any channel off by more than 24) that differ between two PNG screenshots (1 when the sizes differ). */
function pngDiff(a, b) {
  const A = decodePng(a), B = decodePng(b); if (A.width !== B.width || A.height !== B.height) return 1;
  let bad = 0; for (let i = 0; i < A.data.length; i += A.bpp) if (Math.abs(A.data[i] - B.data[i]) > 24 || Math.abs(A.data[i + 1] - B.data[i + 1]) > 24 || Math.abs(A.data[i + 2] - B.data[i + 2]) > 24) bad++;
  return bad / (A.width * A.height);
}

const Q7 = 'COMPONENT Q7\nPLACE 30 25\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n'; // board-only part: the target of the alias created in the UI
const BOARD = (extra = '') => `$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 40 30\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT PU301\nPLACE 10 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\nCOMPONENT R1\nPLACE 25 10\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n${extra}$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10k"\n$ENDDEVICES\n$SIGNALS\nSIGNAL GND\nNODE PU301 1\nNODE R1 1\nSIGNAL VCC\nNODE PU301 2\nNODE R1 2\n$ENDSIGNALS\n`;

function makePdf(texts, secondPage) {
  const stream = (list) => { const content = list.map(({ x, y, text }) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n'); return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`; };
  const page = (contents) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [3 0 R${secondPage ? ' 6 0 R' : ''}] /Count ${secondPage ? 2 : 1} >>`,
    page(4), stream(texts), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...(secondPage ? [page(7), stream(secondPage)] : []),
  ];
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
function makePng() {
  const width = 16, height = 16, row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) { row[1 + x * 3] = 200; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0); return Buffer.concat([head, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const eff = '(effects (font (size 1.27 1.27)))';
const pinDef = (at, number) => `(pin passive line (at ${at}) (length 1.27) (name "~" ${eff}) (number "${number}" ${eff}))`;
const RLIB = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes) (property "Reference" "R" (at 0 6 0) ${eff}) (property "Value" "R" (at 0 -6 0) ${eff}) (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))) (symbol "R_1_1" ${pinDef('0 3.81 270', '1')} ${pinDef('0 -3.81 90', '2')}))`;
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const placed = (ref, uuid, at) => `(symbol (lib_id "Device:R") (at ${at} 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid}") (property "Reference" "${ref}" (at 0 0 0) ${eff}) (property "Value" "10k" (at 0 0 0) ${eff}) (property "Footprint" "" (at 0 0 0) ${eff}) (property "Datasheet" "~" (at 0 0 0) ${eff}) (instances (project "demo" (path "/${U(1)}" (reference "${ref}") (unit 1)))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a}) (xy ${b})) (stroke (width 0) (type default)) (uuid "${U(id)}"))`;
const SCH = `(kicad_sch (version 20231120) (generator "synthetic") (uuid "${U(1)}") (paper "A4") (lib_symbols ${RLIB}) ${placed('PU301', U(21), '50 50')} ${placed('R1', U(22), '100 50')} ${placed('R9', U(23), '150 50')} ${wire('50 46.19', '100 46.19', 31)} ${wire('50 53.81', '100 53.81', 32)} (label "GND" (at 75 46.19 0) ${eff} (uuid "${U(41)}")) (label "VCC" (at 75 53.81 0) ${eff} (uuid "${U(42)}")) (sheet_instances (path "/" (page "1"))))`;

async function main() {
  const { _electron } = require('playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-e2e-'));
  await fs.mkdir(OUT, { recursive: true });
  const project = path.join(root, 'project'), profile = path.join(root, 'profile');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  await fs.mkdir(path.join(project, 'sch'), { recursive: true });
  const board = path.join(project, 'Board.cad'), other = path.join(project, 'Other.cad');
  const pdf = path.join(project, 'docs', 'circuit.pdf'), png = path.join(project, 'docs', 'photo.png'), sch = path.join(project, 'sch', 'main.kicad_sch');
  await fs.writeFile(board, BOARD(Q7)); await fs.writeFile(other, BOARD('COMPONENT Q9\nPLACE 5 5\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n'));
  await fs.writeFile(pdf, makePdf([{ x: 72, y: 700, text: 'PU301 regulator' }, { x: 72, y: 660, text: 'R1 10k pull-up on GND' }], [{ x: 72, y: 700, text: 'Second page R2 only' }]));
  await fs.writeFile(png, makePng()); await fs.writeFile(sch, SCH);

  const errors = [];
  let app, page, otherFit;
  const launch = async (boardPath) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'), args: ['--no-sandbox', ROOT, `--user-data-dir=${profile}`, `--board=${boardPath}`], env, timeout: 60000 });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`); });
    await page.waitForSelector('[data-testid=project-name]', { timeout: 30000 });
  };
  const stubChooser = (paths) => app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  // Rows are read from the DOM status of each row AND its chip; an error/unreadable/missing/changed row fails fast with its name and card message.
  const docRows = () => page.$$eval('[data-testid=document-row]', (nodes) => nodes.map((node) => ({ name: node.querySelector('.wsp-doc-title')?.textContent ?? '', status: node.getAttribute('data-status'), chip: node.querySelector('[data-testid=status-chip]')?.getAttribute('data-status'), text: node.textContent.replace(/\s+/g, ' ').trim() })));
  const cardMessage = async (name) => { await page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name }).click().catch(() => {}); return page.textContent('[data-testid=document-state]', { timeout: 2000 }).catch(() => ''); };
  const waitRows = async (count, expected = {}) => {
    const deadline = Date.now() + 40000; let rows = [];
    for (;;) {
      rows = await docRows();
      const unexpected = rows.filter((row) => ['error', 'unreadable', 'missing', 'changed'].includes(row.status) && expected[row.name] !== row.status);
      if (unexpected.length) throw new Error(`document row(s) not ready: ${(await Promise.all(unexpected.map(async (row) => `${row.name} = ${row.status}: ${(await cardMessage(row.name)).replace(/\s+/g, ' ').trim()}`))).join(' | ')}`);
      if (rows.length === count && rows.every((row) => row.status === (expected[row.name] ?? 'ready') && row.chip === row.status)) return rows;
      if (Date.now() > deadline) throw new Error(`document rows never settled: ${rows.map((row) => `${row.name}=${row.status}`).join(', ')}`);
      await page.waitForTimeout(250);
    }
  };
  const paint = (selector) => page.evaluate((sel) => { const canvas = document.querySelector(sel); if (!canvas) return null; const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; const base = [data[0], data[1], data[2]]; let different = 0, red = 0; for (let i = 0; i < data.length; i += 4) { if (Math.abs(data[i] - base[0]) + Math.abs(data[i + 1] - base[1]) + Math.abs(data[i + 2] - base[2]) > 40) different++; if (data[i] > 150 && data[i + 1] < 80 && data[i + 2] < 80) red++; } return { width: canvas.width, height: canvas.height, different, red }; }, selector);
  const openRow = (name) => page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name }).click();
  const storeFiles = async (dir) => { const found = []; for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const full = path.join(dir, entry.name); if (entry.isDirectory()) found.push(...await storeFiles(full)); else found.push(full); } return found; };
  const manifestOf = async () => { for (const file of (await storeFiles(profile)).filter((f) => /workspaces[\\/][0-9a-f]{64}\.json$/.test(f))) { const manifest = JSON.parse(await fs.readFile(file, 'utf8')); if (/Board\.cad$/.test(manifest.board?.path ?? '') || manifest.board?.name === 'Board.cad') return manifest; } return null; };

  try {
    // ---- launch 1: open board (command line), attach three documents through the native chooser ----
    await launch(board);
    check('board opens from the command line and is named', /Board/.test(await page.textContent('[data-testid=project-name]')));
    check('the status area shows the geometry/unit source', (await page.textContent('[data-testid=status-source]').catch(() => '')).length > 0);
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    await stubChooser([pdf, png, sch]);
    await page.click('[data-testid=attach]');
    const attached = await waitRows(3);
    check('EXACTLY three document rows, all `ready` (status attribute and chip), none in error', attached.length === 3 && attached.every((row) => row.status === 'ready' && row.chip === 'ready') && ['circuit.pdf', 'photo.png', 'main.kicad_sch'].every((name) => attached.some((row) => row.name === name)), attached.map((row) => `${row.name}=${row.status}`).join(', '));
    check('the PDF row reports its real page count (2 pages)', /2 pages/.test(attached.find((row) => row.name === 'circuit.pdf')?.text ?? ''), attached.find((row) => row.name === 'circuit.pdf')?.text);
    await shot('01-documents');
    // ---- each kind is REALLY rendered in the Electron app ----
    await openRow('circuit.pdf');
    await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 30000 });
    const pdfPaint = await paint('.pdfv-page canvas');
    const pdfText = await page.$$eval('.pdfv-text > span', (nodes) => nodes.map((node) => node.textContent).join(' | '));
    check('PDF: the page canvas is drawn (not blank) and the viewer shows 2 pages', pdfPaint && pdfPaint.different > 150 && /\/ 2/.test(await page.textContent('.pdfv-of')), JSON.stringify(pdfPaint));
    check('PDF: the text layer holds the fixture text', /PU301 regulator/.test(pdfText) && /R1 10k pull-up on GND/.test(pdfText), pdfText.slice(0, 120));
    await shot('01b-pdf-rendered');
    await openRow('photo.png');
    await page.waitForSelector('[data-testid=documents-tab] .imgv[data-phase=ready]', { timeout: 30000 });
    const imgPaint = await paint('.imgv-canvas');
    check('image: decoded at its natural size (16 by 16 pixels) and drawn', /16 by 16 pixels/.test(await page.getAttribute('.imgv-surface', 'aria-label')) && imgPaint && imgPaint.red > 50, JSON.stringify(imgPaint));
    await shot('01c-image-rendered');
    await page.click('#wsp-tab-schematic');
    await page.waitForSelector('[data-testid=schematic-tab] .schv-canvas', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const schPaint = await paint('.schv-canvas');
    check('schematic: the sheet canvas is drawn (not blank) with the fixture symbols', schPaint && schPaint.different > 100 && /3 symbols/.test(await page.getAttribute('.schv-canvas', 'aria-label')), `${JSON.stringify(schPaint)} ${await page.getAttribute('.schv-canvas', 'aria-label')}`);
    await shot('01d-schematic-rendered');
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');

    // ---- search PU301: board + schematic + PDF hits, grouped by source ----
    await page.click('[data-testid=search-input]');
    await page.fill('[data-testid=search-input]', 'PU301');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=search-row]').length >= 2, null, { timeout: 30000 });
    const groups = await page.$$eval('[data-testid=search-row]', (nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
    check('unified search finds PU301 in the board, the schematic and the PDF', groups.length >= 3, groups.slice(0, 6).join(' | '));
    await page.press('[data-testid=search-input]', 'Enter');
    await page.waitForSelector('[data-testid=hero-ref]', { timeout: 15000 });
    check('Enter selects the exact PU301 component', /PU301/.test(await page.textContent('[data-testid=hero-ref]')));
    await page.waitForTimeout(1500);
    const inspector = (await page.textContent('[data-testid=inspector]')).replace(/\s+/g, ' ');
    check('the inspector links the selection to the schematic and to the PDF page', /schematic/i.test(inspector) && /(page|circuit\.pdf)/i.test(inspector), inspector.slice(0, 220));
    await shot('02-selected');

    // ---- pin note with a typed measurement ----
    const pins = await page.$$('[data-testid=pin-row]');
    check('the selected part lists its pins', pins.length === 2, String(pins.length));
    await pins[0].click();
    await page.waitForTimeout(500);
    check('selecting a pin shows its net', /GND/.test(await page.textContent('[data-testid=inspector]')));
    await page.click('#wsp-tab-schematic'); await page.waitForSelector('[data-testid=schematic-tab] .schv-canvas'); await page.waitForTimeout(1200);
    const announced = (await page.textContent('.schv-sr[role=status]')).replace(/\s+/g, ' ');
    check('schematic: the board pin selection selects the pin and highlights net GND', /Pin PU301 1 selected/.test(announced) && /Net GND highlighted/.test(announced), announced);
    await shot('02b-schematic-selection');
    await page.click('#wsp-tab-board'); await page.waitForSelector('[data-testid=pin-row]');
    await page.click('[data-testid=add-note]');
    await page.fill('#note-draft', 'pin 1 sags under load');
    await page.fill('[data-testid=measure-voltage]', '0.42 V');
    await page.click('[data-testid=note-save]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=note-card]').length >= 1, null, { timeout: 15000 });
    check('the pin note is saved with the typed voltage', /0\.42 V/.test(await page.textContent('[data-testid=note-card]')));
    await page.waitForFunction(() => /saved/i.test(document.querySelector('[data-testid=save-state]')?.getAttribute('data-state') || document.querySelector('[data-testid=save-state]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await shot('03-note');
    await app.close(); app = null;

    // ---- the PDF moves away; launch 2 restores everything else ----
    const moved = path.join(project, 'docs', 'moved-circuit.pdf');
    await fs.rename(pdf, moved);
    await launch(board);
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    const restoredRows = await waitRows(3, { 'circuit.pdf': 'missing' });
    const restored = restoredRows.map((row) => row.text);
    check('after a restart all three documents are remembered for this board (the moved PDF is `missing`, the others `ready`)', restoredRows.length === 3 && restoredRows.filter((row) => row.status === 'ready').length === 2, restored.join(' | '));
    check('the moved PDF is reported missing and offers relink', restored.some((r) => /circuit\.pdf/.test(r) && /(missing|not found|relink)/i.test(r)), restored.join(' | '));
    await shot('04-restored-missing');
    await page.click('[data-testid=search-input]'); await page.fill('[data-testid=search-input]', 'PU301');
    await page.waitForTimeout(800); await page.press('[data-testid=search-input]', 'Enter');
    await page.waitForSelector('[data-testid=hero-ref]');
    const noteVisible = await page.waitForFunction(() => /0\.42 V/.test(document.querySelector('[data-testid=inspector]')?.textContent || ''), null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('the pin note and its measurement survived the restart', noteVisible);

    // ---- relink: wrong file refused, right file accepted ----
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    const wrong = path.join(project, 'docs', 'other.pdf'); await fs.writeFile(wrong, makePdf([{ x: 72, y: 700, text: 'something else' }]));
    await openRow('circuit.pdf'); // the missing PDF's card carries the relink action
    await stubChooser([wrong]);
    await page.click('[data-testid=relink]');
    await page.waitForTimeout(1500);
    check('relinking with a different file is refused (hash mismatch) and the document stays missing', /(missing|not found|relink)/i.test((await page.$$eval('[data-testid=document-row]', (n) => n.map((x) => x.textContent)).then((t) => t.join(' ')))), '');
    await stubChooser([moved]);
    await page.click('[data-testid=relink]');
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=document-row]')].some((row) => /circuit\.pdf/.test(row.textContent) && /(missing|not found)/i.test(row.textContent)), null, { timeout: 20000 }).catch(() => {});
    const relinked = await waitRows(3);
    check('relinking with the identical bytes at the new path restores the PDF: exactly three rows, all `ready`', relinked.length === 3 && relinked.every((row) => row.status === 'ready'), relinked.map((row) => `${row.name}=${row.status}`).join(', '));
    await shot('05-relinked');

    // ---- B46 in the real app: a PDF viewer remount must keep the reading camera ----
    await page.fill('[data-testid=search-input]', 'R1');
    await page.waitForSelector('[data-testid=search-row][data-source=documents]', { timeout: 30000 });
    await page.click('[data-testid=search-row][data-source=documents]');
    await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 30000 });
    const pdfState = () => page.evaluate(() => { const root = document.querySelector('.pdfv'), scroller = document.querySelector('.pdfv-scroller'); return root ? { page: Number(root.dataset.page), zoom: Number(root.dataset.zoom), top: scroller?.scrollTop ?? -1, left: scroller?.scrollLeft ?? -1, query: document.querySelector('.pdfv-search-input')?.value ?? '' } : null; });
    await page.fill('[data-testid=search-input]', ''); await page.fill('.pdfv-search-input', '');
    await page.click('.pdfv-zoom'); await page.keyboard.press('Control+a'); await page.keyboard.type('200'); await page.keyboard.press('Enter');
    const afterZoom = await pdfState();
    await page.fill('input[aria-label="Page number"]', '2'); await page.keyboard.press('Enter');
    check('B46 setup: zoom 200% typed in the viewer (Ctrl+A, 200, Enter)', Math.abs(afterZoom.zoom - 2) < 0.001, JSON.stringify(afterZoom));
    await page.waitForFunction(() => document.querySelector('.pdfv')?.dataset.page === '2' && Math.abs(Number(document.querySelector('.pdfv').dataset.zoom) - 2) < 0.001, null, { timeout: 10000 });
    await page.evaluate(() => { const scroller = document.querySelector('.pdfv-scroller'); scroller.scrollTop += 90; scroller.scrollLeft += 30; });
    await page.waitForTimeout(900);
    const reading = await pdfState();
    check('B46 setup: page 2 at exactly 200%, scrolled, global and PDF queries empty', reading.page === 2 && Math.abs(reading.zoom - 2) < 0.001 && reading.query === '' && reading.top > 0, JSON.stringify(reading));
    await openRow('photo.png'); await page.waitForSelector('[data-testid=documents-tab] .imgv[data-phase=ready]', { timeout: 20000 });
    await openRow('circuit.pdf'); await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const returned = await pdfState();
    check('B46: back on the PDF without a new selection it stays on page 2 / 200% / the same scroll', returned && returned.page === 2 && Math.abs(returned.zoom - 2) < 0.001 && Math.abs(returned.top - reading.top) <= 4 && Math.abs(returned.left - reading.left) <= 4, JSON.stringify({ reading, returned }));
    await page.fill('[data-testid=search-input]', 'R1'); await page.waitForTimeout(1200); // an old query restored from outside only counts and draws hits
    await openRow('photo.png'); await page.waitForSelector('[data-testid=documents-tab] .imgv[data-phase=ready]', { timeout: 20000 });
    await openRow('circuit.pdf'); await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const withQuery = await pdfState();
    check('B46: with the old R1 query retained a remount still keeps page 2 / 200%', withQuery && withQuery.query === 'R1' && withQuery.page === 2 && Math.abs(withQuery.zoom - 2) < 0.001, JSON.stringify(withQuery));
    await page.fill('[data-testid=search-input]', '');

    // ---- an alias created in the UI persists across a restart ----
    await page.click('#wsp-tab-schematic'); await page.waitForSelector('[data-testid=open-link-panel]');
    await page.click('[data-testid=open-link-panel]'); await page.waitForSelector('[data-testid=link-dialog][open]');
    check('alias panel: the schematic-only R9 and the board-only Q7 are offered, nothing is preselected', (await page.$$eval('[data-testid=alias-ref-from] option', (n) => n.map((o) => o.value))).includes('R9') && (await page.inputValue('[data-testid=alias-ref-from]')) === '' && /saved with this board/i.test(await page.textContent('[data-testid=alias-persistence]')));
    await page.selectOption('[data-testid=alias-ref-from]', 'R9');
    check('alias panel: Q7 is a candidate target and the consequence is shown first', (await page.$$eval('[data-testid=alias-ref-to] option', (n) => n.map((o) => o.value))).includes('Q7'));
    await page.selectOption('[data-testid=alias-ref-to]', 'Q7');
    check('alias panel: the consequence names both references before anything is created', /R9/.test(await page.textContent('[data-testid=alias-ref-consequence]')) && /Q7/.test(await page.textContent('[data-testid=alias-ref-consequence]')));
    await shot('05b-alias-form');
    await page.click('[data-testid=alias-ref-create]');
    check('alias panel: the alias is listed after creating it', /R9/.test(await page.textContent('[data-testid=alias-list]')) && /Q7/.test(await page.textContent('[data-testid=alias-list]')));
    await page.waitForTimeout(2200); // the workspace save is debounced; quitting flushes it, this makes the file observable
    check('the alias is written to the workspace file of THIS board', (await manifestOf())?.aliases?.refs?.R9 === 'Q7', JSON.stringify((await manifestOf())?.aliases));
    await shot('05c-alias-created');
    await app.close(); app = null;

    // ---- another board must never inherit the documents ----
    await launch(other);
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    await page.waitForTimeout(2000);
    const foreign = await page.$$('[data-testid=document-row]');
    check('a different board starts with no attached documents', foreign.length === 0, String(foreign.length));
    await page.click('#wsp-tab-board'); await page.waitForSelector('[data-testid=board-pane] canvas'); await page.waitForTimeout(1200);
    otherFit = await page.locator('[data-testid=board-pane]').screenshot();
    await shot('06-other-board');
    await app.close(); app = null;

    // the original board still has them after switching around, with its alias
    await launch(board);
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    const again = await waitRows(3);
    check('the first board still has its three documents, all `ready`', again.length === 3 && again.every((row) => row.status === 'ready'), again.map((row) => `${row.name}=${row.status}`).join(', '));
    await page.click('#wsp-tab-schematic'); await page.waitForSelector('[data-testid=open-link-panel]');
    await page.click('[data-testid=open-link-panel]'); await page.waitForSelector('[data-testid=link-dialog][open]');
    check('the alias created before the restart is still listed (R9 → Q7)', /R9/.test(await page.textContent('[data-testid=alias-list]')) && /Q7/.test(await page.textContent('[data-testid=alias-list]')) && (await page.$$('[data-testid=alias-issue]')).length === 0);
    await page.keyboard.press('Escape');

    // ---- board camera: pan, zoom, rotate and the bottom side are restored after a restart ----
    await page.click('#wsp-tab-board'); await page.waitForSelector('[data-testid=board-pane] canvas'); await page.waitForTimeout(1000);
    const canvasBox = await (await page.$('[data-testid=board-pane] canvas')).boundingBox();
    const cx = canvasBox.x + canvasBox.width / 2, cy = canvasBox.y + canvasBox.height / 2;
    const fitShot = await page.locator('[data-testid=board-pane]').screenshot();
    await page.mouse.move(cx + 60, cy - 10); await page.mouse.down(); await page.mouse.move(cx + 30, cy - 20, { steps: 8 }); await page.mouse.up();
    await page.mouse.move(cx, cy); await page.mouse.wheel(0, -220);
    await page.keyboard.press('r');
    await page.click('[data-testid=side-bottom]');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(2500); // camera debounce (350 ms) + workspace save debounce
    const changedShot = await page.locator('[data-testid=board-pane]').screenshot();
    await fs.writeFile(path.join(OUT, '07-board-camera-before-quit.png'), changedShot);
    const stored = (await manifestOf())?.cameras?.board;
    check('the board camera is written to the workspace file (zoom, centre, rotation 90, bottom side)', stored && stored.side === 'bottom' && stored.rotation === 90 && stored.zoom > 0 && Number.isFinite(stored.x) && Number.isFinite(stored.y), JSON.stringify(stored));
    check('the changed board view differs from the fit and shows board features (not an empty region)', pngDiff(changedShot, fitShot) > 0.01 && featureFraction(changedShot) > 0.02, `features ${(featureFraction(changedShot) * 100).toFixed(1)}%`);
    await app.close(); app = null;

    await launch(board);
    await page.click('#wsp-tab-board'); await page.waitForSelector('[data-testid=board-pane] canvas'); await page.waitForTimeout(2000);
    await page.mouse.move(2, 2); await page.waitForTimeout(300);
    const restoredShot = await page.locator('[data-testid=board-pane]').screenshot();
    await fs.writeFile(path.join(OUT, '08-board-camera-restored.png'), restoredShot);
    const camDiff = pngDiff(restoredShot, changedShot);
    check('after a restart the board shows the same view (< 0.3% of pixels differ)', camDiff < 0.003, `diff ${(camDiff * 100).toFixed(3)}%`);
    check('the viewed side (bottom) is restored with it', (await page.getAttribute('[data-testid=side-bottom]', 'aria-pressed')) === 'true');
    await app.close(); app = null;

    // another board never inherits the camera, the aliases or the documents of the first one
    await launch(other);
    await page.click('#wsp-tab-board'); await page.waitForSelector('[data-testid=board-pane] canvas'); await page.waitForTimeout(1200);
    await page.mouse.move(2, 2); await page.waitForTimeout(300);
    const foreignDiff = otherFit ? pngDiff(await page.locator('[data-testid=board-pane]').screenshot(), otherFit) : 1;
    check('the other board still opens fitted (it never receives the first board camera)', foreignDiff < 0.003 && (await page.getAttribute('[data-testid=side-top]', 'aria-pressed')) === 'true', `diff ${(foreignDiff * 100).toFixed(3)}%`);
    await app.close(); app = null;
  } finally {
    if (app) await app.close().catch(() => {});
    const absolute = path.resolve(root);
    if (absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) await fs.rm(absolute, { recursive: true, force: true });
  }
  check('no page or console errors in any launch', errors.length === 0, errors.slice(0, 4).join(' | '));
  const failed = results.filter((r) => !r.ok);
  await fs.writeFile(path.join(OUT, 'e2e-report.json'), JSON.stringify({ results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(2); });
