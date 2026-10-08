'use strict';

// End-to-end proof of text recognition (OCR) in the REAL built Electron app (dist/ + electron/main.cjs + preload), in its production
// security model: file:// page, the shipped CSP (no 'wasm-unsafe-eval'), sandboxed renderer, the OCR worker and assets from dist/.
//   open a synthetic board -> attach a synthetic SCANNED PDF (image only, no text layer) through the native chooser -> the viewer offers
//   "Recognize text" -> recognition finishes -> recognized words are marked, searchable and linked to the board ONLY on exact names ->
//   a link selects the board part -> no network request, no CSP violation, no console error -> reopened, the recognized text is back.
// All data is synthetic and generated here (labels drawn with pdf.js' own Node canvas). Needs a production build:
//
//   pnpm build && node scripts/qa-ocr.cjs              (development Electron with ROOT)
//   node scripts/qa-ocr.cjs --packaged                  (release/win-unpacked from `pnpm package:dir`)
//
// Env: TRACE_QA_OUT (screenshots and report, default <tmp>/trace-ocr-qa), TRACE_ACCEPT_NO_SANDBOX=1 on Linux containers (root).

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TRACE_QA_OUT || path.join(os.tmpdir(), 'trace-ocr-qa');
const PACKAGED = process.argv.includes('--packaged');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- synthetic board: the labels of the scan that are board references or nets, plus one the scan does not contain
const BOARD = `$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 60 40\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\n${['U7', 'R220', 'C14', 'Q12', 'R22'].map((ref, i) => `COMPONENT ${ref}\nPLACE ${8 + i * 10} 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n`).join('')}$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10k"\n$ENDDEVICES\n$SIGNALS\nSIGNAL GND\nNODE U7 1\nNODE R220 1\nNODE C14 1\nSIGNAL VCC_3V3\nNODE U7 2\nNODE R220 2\nNODE Q12 1\n$ENDSIGNALS\n`;

/** An image-only PDF: the labels are pixels (rendered with pdf.js' Node canvas, @napi-rs/canvas), so the file has no text layer. */
function scannedPdf() {
  const pdfjsRoot = fsSync.realpathSync(path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [ROOT] })));
  const { createCanvas } = createRequire(path.join(pdfjsRoot, 'package.json'))('@napi-rs/canvas');
  const dpi = 300, widthPt = 420, heightPt = 300, scale = dpi / 72;
  const width = Math.round(widthPt * scale), height = Math.round(heightPt * scale);
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.font = `${Math.round(14 * scale)}px sans-serif`;
  ctx.fillText('U7    R220    C14', 30 * scale, 60 * scale);
  ctx.fillText('VCC_3V3    GND    R2201', 30 * scale, 150 * scale);
  ctx.strokeRect(20 * scale, 180 * scale, 380 * scale, 2 * scale); // a drawing line under the labels
  ctx.save(); ctx.translate(360 * scale, 290 * scale); ctx.rotate(-Math.PI / 2); ctx.fillText('Q12', 0, 0); ctx.restore(); // reads bottom to top
  const rgba = ctx.getImageData(0, 0, width, height).data, gray = Buffer.alloc(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  const image = zlib.deflateSync(gray), content = Buffer.from(`q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im1 Do Q`);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [];
  let offset = chunks[0].length;
  objects.forEach((body, i) => { offsets.push(offset); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]); chunks.push(part); offset += part.length; });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function main() {
  const { _electron } = require('playwright');
  if (PACKAGED) {
    const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
    const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
    const asar = libraryRequire('@electron/asar');
    const archive = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
    const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/'));
    const assets = entries.filter(name => /^\/dist\/assets\/(?:ocr\.worker-.+\.js|tesseract-core-(?:simd-)?lstm-.+\.wasm|eng\.traineddata-.+\.gz)$/.test(name));
    const bytes = assets.reduce((sum, name) => sum + asar.statFile(archive, name.slice(1).split('/').join(path.sep)).size, 0);
    check('the archive includes exactly four bundled OCR assets', assets.length === 4, `${bytes} bytes`);
    check('unused OCR package trees and native canvas binaries are absent from the archive', !entries.some(name => /^\/node_modules\/(?:tesseract\.js-core|@tesseract\.js-data|@napi-rs)(?:\/|$)/.test(name)));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-ocr-'));
  await fs.mkdir(OUT, { recursive: true });
  const project = path.join(root, 'project'), profile = path.join(root, 'profile');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  const board = path.join(project, 'Board.cad'), pdf = path.join(project, 'docs', 'scanned.pdf');
  await fs.writeFile(board, BOARD);
  await fs.writeFile(pdf, scannedPdf());
  const executablePath = PACKAGED ? path.join(ROOT, 'release', 'win-unpacked', process.platform === 'win32' ? 'TRACE Boardviewer.exe' : 'trace-boardviewer')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const errors = [], csp = [];
  let app, page;
  const launch = async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    const args = [...(PACKAGED ? [] : [ROOT]), `--user-data-dir=${profile}`, `--board=${board}`];
    if (process.platform === 'linux' && process.getuid?.() === 0) { args.unshift('--no-sandbox'); env.TRACE_ACCEPT_NO_SANDBOX = '1'; }
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 });
    // Every request of the default session (page AND workers) is recorded; only file: (and devtools:) may appear.
    await app.evaluate(({ session }) => {
      globalThis.__ocrQaRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => { globalThis.__ocrQaRequests.push(details.url.slice(0, 600)); callback({}); });
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to (compile|load|connect|execute)/i.test(text)) csp.push(text.slice(0, 240));
      if (message.type() === 'error') errors.push(`console: ${text.slice(0, 240)}`);
    });
    await page.waitForSelector('[data-testid=project-name]', { timeout: 30000 });
    // The support notice of a fresh profile is modal: skip it like a user would.
    const notice = page.locator('[data-testid=support-not-now]');
    if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) await notice.click();
    await page.waitForSelector('[data-testid=support-notice]', { state: 'detached', timeout: 10000 }).catch(() => {});
  };
  const stubChooser = (paths) => app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, paths);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${PACKAGED ? 'packaged' : 'electron'}-${name}.png`) });
  const openRow = (name) => page.locator('[data-testid=document-row] .wsp-doc-main', { hasText: name }).click();
  const timings = {};
  try {
    await launch();
    check('the production page is a file:// URL with the shipped CSP (no wasm-unsafe-eval, no unsafe-eval)', page.url().startsWith('file:///')
      && await page.evaluate(() => { const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''; return /script-src 'self';/.test(policy) && !/unsafe-eval/.test(policy); }), page.url().slice(0, 60));
    await page.click('#wsp-tab-documents'); await page.waitForSelector('[data-testid=documents-tab]');
    await stubChooser([pdf]);
    await page.click('[data-testid=attach]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=document-row]')].some((row) => /scanned\.pdf/.test(row.textContent) && row.getAttribute('data-status') === 'ready'), null, { timeout: 30000 });
    await openRow('scanned.pdf');
    await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { timeout: 30000 });
    const offer = page.locator('[data-notice=raster] [data-action=recognize-text]');
    await offer.waitFor({ timeout: 20000 });
    check('a scanned PDF without a text layer offers "Recognize text" (and no text layer is pretended)', await offer.isVisible() && await page.locator('.pdfv-text > span').count() === 0);
    await shot('1-offer');
    const started = Date.now();
    await offer.click();
    await page.waitForSelector('[data-notice=ocr-running]', { timeout: 10000 }).catch(() => {});
    const sawProgress = await page.locator('[data-notice=ocr-running] [data-action=stop-recognition]').count() > 0 || await page.locator('[data-notice=ocr-summary]').count() > 0;
    await page.waitForSelector('[data-notice=ocr-summary]', { timeout: 180000 });
    timings.recognizeMs = Date.now() - started;
    check('recognition shows progress with a stop button and finishes with a summary', sawProgress, `${timings.recognizeMs} ms for one 420 x 300 pt page at 300 dpi (indicative)`);
    const words = await page.$$eval('.pdfv-text-ocr > span', (nodes) => nodes.map((node) => ({ text: node.textContent, title: node.title, low: node.classList.contains('is-low') })));
    const texts = words.map((word) => word.text);
    check('the recognized words are on the page, each marked with its confidence', ['U7', 'R220', 'C14', 'VCC_3V3', 'GND', 'R2201', 'Q12'].every((label) => texts.includes(label)) && words.every((word) => /\d/.test(word.title)), texts.join(' '));
    check('the page carries the "Recognized text" badge', await page.locator('.pdfv-ocr-badge').count() === 1, await page.locator('.pdfv-ocr-badge').getAttribute('title'));
    await shot('2-recognized');
    await page.fill('.pdfv-search-input', 'R2201');
    await page.waitForFunction(() => /^1 \/ 1$/.test(document.querySelector('[data-testid=pdfv-count]')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
    check('recognized words are searchable (R2201: one hit, marked as recognized)', /^1 \/ 1$/.test(await page.textContent('[data-testid=pdfv-count]')) && await page.locator('.pdfv-hit.is-ocr').count() === 1, await page.textContent('[data-testid=pdfv-count]'));
    await page.fill('.pdfv-search-input', '');
    await page.waitForFunction(() => document.querySelectorAll('.pdfv-probe.is-ocr').length >= 4, null, { timeout: 20000 }).catch(() => {});
    const probes = await page.$$eval('.pdfv-probe', (nodes) => nodes.map((node) => ({ label: node.getAttribute('aria-label') ?? '', ocr: node.classList.contains('is-ocr') })));
    const linked = probes.map((probe) => probe.label.split(',')[0]);
    check('exact board names link (U7, R220, C14, Q12, GND, VCC_3V3), and they are marked as recognized text', ['U7', 'R220', 'C14', 'GND', 'VCC_3V3'].every((name) => linked.includes(name)) && probes.every((probe) => probe.ocr && /\d/.test(probe.label)), linked.join(' '));
    check('R22 is a board part but only appears inside R220/R2201 on the scan: it is never linked', !linked.includes('R22'));
    check('the vertical label Q12 (read bottom to top) links too', linked.includes('Q12'));
    await page.locator('.pdfv-probe[aria-label^="R220,"]').first().click();
    await page.waitForTimeout(500);
    const hero = await page.textContent('.hero-ref').catch(() => '');
    check('a link from recognized text selects the board part', /R220/.test(hero ?? ''), hero);
    await shot('3-linked');
    // Reopen: the recognized text comes back from the session cache without running the engine again.
    await page.click('#wsp-tab-documents');
    await openRow('scanned.pdf');
    await page.waitForSelector('.pdfv-ocr-badge', { timeout: 15000 }).catch(() => {});
    check('the document opened again shows its recognized text at once', await page.locator('.pdfv-ocr-badge').count() === 1 && await page.locator('[data-action=recognize-text]').count() === 0);
    const requests = await app.evaluate(() => globalThis.__ocrQaRequests ?? []);
    const remote = requests.filter((url) => !/^(file|devtools|chrome-extension|data|blob):/i.test(url));
    check('no network request from the page or its workers (only file: URLs)', remote.length === 0, remote.length ? remote.slice(0, 5).join(' ') : `${requests.length} file requests`);
    const ocrUrls = requests.filter((url) => /ocr\.worker|tesseract-core|eng\.traineddata/.test(url));
    const ocrFiles = ocrUrls.map((url) => url.split('/').pop());
    if (PACKAGED) check('in the package they are read from inside app.asar (dist/assets)', ocrUrls.length > 0 && ocrUrls.every((url) => /\/resources\/app\.asar\/dist\/assets\//.test(url)), ocrUrls.map((url) => url.replace(/^.*\/resources\//, 'resources/')).join(', '));
    // (the script load of a dedicated worker is not reported to webRequest; the engine bytes are, because the renderer reads them)
    check('ONE engine build (SIMD where it validates) and the language data are read from the application files', ocrFiles.filter((name) => /\.wasm/.test(name)).length === 1 && ocrFiles.some((name) => /traineddata/.test(name)), ocrFiles.join(', '));
    check('no CSP violation (WebAssembly runs in the worker without relaxing the page policy)', csp.length === 0, csp.join(' | '));
    check('no page error or console error', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (error) {
    check('the run completed', false, error.stack ?? String(error));
    if (page) await shot('failure').catch(() => {});
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const failed = results.filter((result) => !result.ok);
  await fs.writeFile(path.join(OUT, `${PACKAGED ? 'packaged' : 'electron'}-report.json`), JSON.stringify({ packaged: PACKAGED, timings, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${timings.recognizeMs ? `, recognition ${timings.recognizeMs} ms` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main();
