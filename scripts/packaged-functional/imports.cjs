'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { zipSync, zlibSync } = require('fflate');

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value);
const lines = (value) => bytes(`${value.join('\n')}\n`);

const GENCAD = [
  '$HEADER', 'GENCAD 1.4', 'UNITS MM', 'ORIGIN 0 0', '$ENDHEADER',
  '$BOARD', 'RECTANGLE 0 0 40 30', '$ENDBOARD', '$PADS', 'PAD P ROUND -1', 'CIRCLE 0 0 0.2', '$ENDPADS',
  '$PADSTACKS', 'PADSTACK PS 0', 'PAD P TOP 0 0', '$ENDPADSTACKS', '$SHAPES', 'SHAPE S', 'RECTANGLE -2 -1 4 2',
  'PIN 1 PS -1 0 TOP 0 0', 'PIN 2 PS 1 0 TOP 0 0', '$ENDSHAPES', '$COMPONENTS', 'COMPONENT R1', 'PLACE 10 20',
  'LAYER TOP', 'ROTATION 0', 'SHAPE S 0 0', 'DEVICE D', '$ENDCOMPONENTS', '$DEVICES', 'DEVICE D',
  'VALUE "10 kOhm"', '$ENDDEVICES', '$SIGNALS', 'SIGNAL GND', 'NODE R1 1', '$ENDSIGNALS',
].join('\n') + '\n';

const ASC = Object.freeze({
  'format.asc': lines([...Array.from({ length: 8 }, (_, i) => `; synthetic format header ${i + 1}`), '0.000 0.000', '2.000 0.000', '2.000 1.000', '0.000 1.000']),
  'pins.asc': lines([...Array.from({ length: 8 }, (_, i) => `; synthetic pins header ${i + 1}`), 'Part U1 (T)', '1  1  0.100 0.200  1  VCC  5']),
  'nails.asc': lines(Array.from({ length: 7 }, (_, i) => `; synthetic nails header ${i + 1}`)),
});

function zipEntries(entries) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, data])));
}

function publishedDefaultKey(variant) {
  const sourcePath = path.resolve(__dirname, '../../src/lib/formats/fz-default-keys.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const symbol = variant === 'cae' ? 'CAE_DEFAULT_KEY' : 'FZ_DEFAULT_KEY';
  const match = source.match(new RegExp(`export const ${symbol}:[\\s\\S]*?= Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
  assert(match, `synthetic ${variant.toUpperCase()} fixture requires its published base-key data`);
  const key = [...match[1].matchAll(/0x[\da-f]+/gi)].map(([word]) => Number.parseInt(word, 16) >>> 0);
  assert(key.length === 44, `${variant.toUpperCase()} published key must contain 44 words`);
  return key;
}

function rc6Feedback(data, key) {
  const rotate = (value, shift) => (value << (shift & 31) | value >>> (32 - (shift & 31))) >>> 0;
  const words = new Uint32Array(4);
  const rounds = (a, b, c, d) => {
    b = (b + key[0]) >>> 0; d = (d + key[1]) >>> 0;
    for (let round = 1; round <= 20; round++) {
      const t = rotate(Math.imul(b, (Math.imul(2, b) + 1) >>> 0), 5);
      const u = rotate(Math.imul(d, (Math.imul(2, d) + 1) >>> 0), 5);
      a = (rotate(a ^ t, u) + key[round * 2]) >>> 0;
      c = (rotate(c ^ u, t) + key[round * 2 + 1]) >>> 0;
      const previousA = a; a = b; b = c; c = d; d = previousA;
    }
    words[0] = (a + key[42]) >>> 0; words[1] = b; words[2] = (c + key[43]) >>> 0; words[3] = d;
  };
  const result = new Uint8Array(data.length), feedback = new Uint8Array(16), view = new DataView(feedback.buffer);
  for (let index = 0; index < data.length; index++) {
    rounds(view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true));
    result[index] = data[index] ^ (words[0] & 255);
    feedback.copyWithin(0, 1); feedback[15] = result[index];
  }
  return result;
}

function encryptedFzFixture(variant) {
  const content = bytes([
    'UNIT:thou',
    'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!',
    'S!U1!!SOIC8!NO!0!',
    'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!',
    'S!GND!U1!1!VSS!1000!2000!!6!',
  ].join('\n') + '\n');
  const description = bytes('Synthetic board\nPARTNO\tDESCRIPTION\tQTY\tLOCATIONS\tPARTNO2\n0001\tIC SOIC8\t1\tU1\t\n');
  const contentZip = zlibSync(content), descriptionZip = zlibSync(description);
  const u32 = (value) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
  const framed = Uint8Array.from([
    ...u32(contentZip.length), ...contentZip, ...u32(descriptionZip.length), ...descriptionZip,
    ...u32(descriptionZip.length + 8),
  ]);
  return rc6Feedback(framed, publishedDefaultKey(variant));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitVisible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  assert(await locator.isVisible(), `${label} must be visible`);
}

async function assertActiveSource(page, requestedPath) {
  const expectedRealPath = await fs.promises.realpath(requestedPath);
  const deadline = Date.now() + 15000;
  let displayed = null;
  while (Date.now() <= deadline) {
    displayed = await page.locator('.project-heading').getAttribute('title');
    if (typeof displayed === 'string' && displayed.length > 0) {
      try {
        if (await fs.promises.realpath(displayed) === expectedRealPath) {
          return { requestedSpelling: requestedPath, displayedSpelling: displayed, canonicalRealPath: expectedRealPath };
        }
      } catch { /* a stale or transient title is retried until the requested source is committed */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(false, 'the active board source must resolve to the requested native file before board counts are checked');
}

async function run(ctx) {
  const required = ['step', 'registerFixture', 'openFiles', 'waitBoard', 'getPage', 'screenshot', 'restart', 'dismissSupport'];
  for (const name of required) assert(typeof ctx?.[name] === 'function', `packaged import QA requires ctx.${name}()`);
  assert(path.isAbsolute(ctx.fixtureDir), 'packaged import QA requires an absolute private fixture directory');

  const cad = bytes(GENCAD);
  const encoded = zipEntries({ 'projeté/board.cad': cad, 'projeté/readme.txt': bytes('synthetic archive companion\n') });
  const ascZip = zipEntries(Object.fromEntries(Object.entries(ASC).map(([name, content]) => [`réparation/${name}`, content])));
  const unsafeZip = zipEntries({ '../escape.cad': cad });
  const ambiguousZip = zipEntries({ 'a.cad': cad, 'nested/b.cad': cad });
  const xzzVectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../tests/fuzz/corpus/xzz.json'), 'utf8'));
  const xzzVector = xzzVectors.find((entry) => entry.kind === 'valid' && /^[0-9a-f]{16}$/i.test(entry.options?.xzzKey ?? ''));
  assert(xzzVector, 'synthetic XZZ corpus must include a valid encrypted vector with its synthetic user key');
  const xzzBytes = Buffer.from(xzzVector.b64, 'base64');
  const xzzPath = await ctx.registerFixture('keys/synthetic-user-key.pcb', xzzBytes);
  const fzPaths = await Promise.all([
    ctx.registerFixture('keys/synthetic-base-key.fz', encryptedFzFixture('fz')),
    ctx.registerFixture('keys/synthetic-base-key.cae', encryptedFzFixture('cae')),
  ]);

  const nfcPath = await ctx.registerFixture('unicode/board café #50%.cad', cad);
  const nfdCandidate = path.join(path.dirname(nfcPath), 'board cafe\u0301 #50%.cad');
  const normalizationSensitive = !fs.existsSync(nfdCandidate);
  const nfdPath = normalizationSensitive ? await ctx.registerFixture('unicode/board cafe\u0301 #50%.cad', cad) : nfdCandidate;
  const unicodePaths = [nfcPath, nfdPath];
  const zipPaths = await Promise.all([
    ctx.registerFixture('archives/unicode-entries.zip', encoded),
    ctx.registerFixture('archives/unicode-asc-companions.zip', ascZip),
    ctx.registerFixture('archives/unsafe-path.zip', unsafeZip),
    ctx.registerFixture('archives/ambiguous-boards.zip', ambiguousZip),
  ]);
  const directAsc = await Promise.all(Object.entries(ASC).map(([name, content]) => ctx.registerFixture(`asc/${name}`, content)));
  let registeredFixtures = 10 + (normalizationSensitive ? 2 : 1);
  const getCurrentPage = () => {
    const page = ctx.getPage();
    assert(page && typeof page.locator === 'function', 'ctx.getPage() must return the current Playwright page');
    return page;
  };

  let unicodeVolume = null;
  await ctx.step('Import Unicode native paths without rewriting filename bytes', async () => {
    const page = getCurrentPage();
    const identities = [];
    for (const filePath of unicodePaths) {
      assert(fs.existsSync(filePath), 'registered Unicode fixture must exist before native open');
      await ctx.openFiles([filePath]);
      identities.push(await assertActiveSource(page, filePath));
      await ctx.waitBoard({ components: 1, pins: 2, nets: 1 });
    }
    unicodeVolume = { lexicalSpellings: unicodePaths.map((filePath) => path.basename(filePath)), normalizationSensitive, identities };
    await ctx.screenshot('imports-unicode-paths');
    return { ...unicodeVolume, normalizationForms: ['NFC', 'NFD'], namesInclude: ['space', 'percent', 'number sign'] };
  });

  await ctx.step('Measure the fixture volume case behavior and open case twins only when distinct', async () => {
    const page = getCurrentPage();
    const upper = await ctx.registerFixture('case/Board.cad', cad);
    registeredFixtures++;
    const lowerCandidate = path.join(path.dirname(upper), 'board.cad');
    const caseSensitive = !fs.existsSync(lowerCandidate);
    let lower;
    if (caseSensitive) {
      const other = bytes(GENCAD.replace('COMPONENT R1', 'COMPONENT R2').replace('NODE R1 1', 'NODE R2 1'));
      lower = await ctx.registerFixture('case/board.cad', other);
      registeredFixtures++;
      assert(path.resolve(upper) !== path.resolve(lower), 'case-distinct fixtures must have distinct absolute paths');
      await ctx.openFiles([upper]);
      await assertActiveSource(page, upper);
      await ctx.waitBoard({ components: 1, pins: 2, nets: 1 });
      await ctx.openFiles([lower]);
      await assertActiveSource(page, lower);
      await ctx.waitBoard({ components: 1, pins: 2, nets: 1 });
      await ctx.screenshot('imports-case-distinct');
    }
    return { platform: process.platform, filesystemCaseSensitive: caseSensitive, lexicalSpellings: caseSensitive ? [upper, lower] : [upper, lowerCandidate], caseTwinCoverage: caseSensitive ? 'opened both case-distinct synthetic paths' : 'expected unavailable on this case-folded volume' };
  });

  await ctx.step('Import a Unicode ZIP member as one board', async () => {
    const page = getCurrentPage();
    await ctx.openFiles([zipPaths[0]]);
    const source = await assertActiveSource(page, zipPaths[0]);
    await ctx.waitBoard({ components: 1, pins: 2, nets: 1 });
    await ctx.screenshot('imports-unicode-zip-member');
    return { source, archiveEntries: ['projeté/board.cad', 'projeté/readme.txt'], companionData: 'synthetic' };
  });

  await ctx.step('Resolve ZIP companions from the same Unicode folder', async () => {
    const page = getCurrentPage();
    await ctx.openFiles([zipPaths[1]]);
    const source = await assertActiveSource(page, zipPaths[1]);
    await ctx.waitBoard({ components: 1, pins: 1, nets: 1 });
    await ctx.screenshot('imports-zip-asc-companions');
    return { source, openedEntry: 'réparation/format.asc', companionEntries: ['réparation/pins.asc', 'réparation/nails.asc'] };
  });

  await ctx.step('Reject unsafe and ambiguous ZIP board candidates', async () => {
    const page = getCurrentPage();
    const errorToast = page.locator('.toast.error');
    const clearOldRefusals = async () => {
      if (await errorToast.count()) {
        await page.locator('.toast.error button').evaluateAll((buttons) => buttons.forEach((button) => button.click()));
        await errorToast.first().waitFor({ state: 'detached', timeout: 15000 });
      }
    };
    const sourceBeforeUnsafe = await page.locator('.project-heading').getAttribute('title');
    assert(sourceBeforeUnsafe, 'a previously opened board source must be visible before the unsafe archive attempt');
    await clearOldRefusals();
    await ctx.openFiles([zipPaths[2]]);
    await waitVisible(errorToast, 'unsafe archive refusal');
    const unsafeMessage = (await errorToast.textContent())?.trim() ?? '';
    assert(unsafeMessage, 'fresh unsafe archive refusal must display explanatory text');
    assert(await fs.promises.realpath(await page.locator('.project-heading').getAttribute('title')) === await fs.promises.realpath(sourceBeforeUnsafe), 'the unsafe archive must leave the previously active source unchanged');
    const sourceBeforeAmbiguous = await page.locator('.project-heading').getAttribute('title');
    assert(sourceBeforeAmbiguous, 'the active board source must remain visible before the ambiguous archive attempt');
    await clearOldRefusals();
    await ctx.openFiles([zipPaths[3]]);
    await waitVisible(errorToast, 'ambiguous archive refusal');
    const ambiguousMessage = (await errorToast.textContent())?.trim() ?? '';
    assert(ambiguousMessage, 'fresh ambiguous archive refusal must display explanatory text');
    assert(await fs.promises.realpath(await page.locator('.project-heading').getAttribute('title')) === await fs.promises.realpath(sourceBeforeAmbiguous), 'the ambiguous archive must leave the previously active source unchanged');
    assert(ambiguousMessage !== unsafeMessage, 'each rejected archive must produce its own specific refusal');
    return { unsafeArchiveRejected: true, ambiguousArchiveRejected: true };
  });

  await ctx.step('Open the synthetic ASC companion trio through its native input path', async () => {
    const page = getCurrentPage();
    await ctx.openFiles([directAsc[0]]);
    const source = await assertActiveSource(page, directAsc[0]);
    await ctx.waitBoard({ components: 1, pins: 1, nets: 1 });
    await ctx.screenshot('imports-asc-companions');
    return { source, selectedEntry: path.basename(directAsc[0]), companions: directAsc.slice(1).map((filePath) => path.basename(filePath)) };
  });

  await ctx.step('Exercise XZZ key skip, wrong-key recovery, success and session-only restart behavior', async () => {
    const page = getCurrentPage();
    const dialog = page.locator('[data-testid="key-dialog"]');
    const keyInput = page.locator('#board-key');
    const sourceBeforeSkip = await page.locator('.project-heading').getAttribute('title');
    assert(sourceBeforeSkip, 'the previously active board source must be visible before the XZZ key request');
    await ctx.openFiles([xzzPath]);
    await waitVisible(dialog, 'XZZ key request');
    assert((await dialog.textContent()).includes(path.basename(xzzPath)), 'the initial key request must name the requested XZZ input');
    await page.locator('[data-testid="key-skip"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 15000 });
    assert(await fs.promises.realpath(await page.locator('.project-heading').getAttribute('title')) === await fs.promises.realpath(sourceBeforeSkip), 'skipping the XZZ key must leave the previously active board unchanged');

    await ctx.openFiles([xzzPath]);
    await waitVisible(dialog, 'XZZ key request after skip');
    const keyRequestText = await dialog.textContent();
    await keyInput.fill('010f0c0a05030606');
    await page.locator('[data-testid="key-submit"]').click();
    await page.waitForFunction((previous) => {
      const dialogText = document.querySelector('[data-testid="key-dialog"]')?.textContent;
      return Boolean(dialogText && dialogText !== previous);
    }, keyRequestText, { timeout: 15000 });
    await waitVisible(dialog, 'XZZ key retry after wrong synthetic key');
    assert(await dialog.textContent() !== keyRequestText, 'wrong-key retry must update the current key failure details');
    await keyInput.fill(xzzVector.options.xzzKey);
    await page.locator('[data-testid="key-submit"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 15000 });
    await assertActiveSource(page, xzzPath);
    await ctx.waitBoard({ components: 2, pins: 4, nets: 2 });
    await ctx.screenshot('imports-xzz-user-key');

    await ctx.restart();
    const currentPage = ctx.getPage();
    const supportNotice = currentPage.locator('[data-testid="support-notice"]');
    await waitVisible(supportNotice, 'post-restart support notice');
    await ctx.dismissSupport();
    await supportNotice.waitFor({ state: 'hidden', timeout: 15000 });
    assert(!(await supportNotice.isVisible()), 'the normal post-restart support-notice skip must close the visible notice before native open');
    const afterRestart = currentPage.locator('[data-testid="key-dialog"]');
    await ctx.openFiles([xzzPath]);
    await waitVisible(afterRestart, 'XZZ key request after normal process restart');
    assert((await afterRestart.textContent()).includes(path.basename(xzzPath)), 'the post-restart key request must name the requested XZZ input before it is accepted');
    await currentPage.locator('[data-testid="key-skip"]').click();
    await afterRestart.waitFor({ state: 'hidden', timeout: 15000 });
    return { key: 'synthetic-only', skipped: true, wrongKeyRejected: true, acceptedKeySessionOnly: true, restart: 'normal harness restart' };
  });

  await ctx.step('Open synthetic FZ and CAE boards with their permitted published base keys', async () => {
    const page = getCurrentPage();
    const sources = [];
    for (const filePath of fzPaths) {
      await ctx.openFiles([filePath]);
      sources.push(await assertActiveSource(page, filePath));
      await ctx.waitBoard({ components: 1, pins: 1, nets: 1 });
    }
    await ctx.screenshot('imports-fz-cae-published-base-keys');
    return { sources, variants: ['FZ', 'CAE'], keyMaterial: 'published per-format base keys, used only to build synthetic test inputs', keyPrompt: 'not expected' };
  });

  return { module: 'imports', fixtureCount: registeredFixtures, unicodeVolume, fixtureSources: 'authored synthetic GenCAD/ASC/FZ/CAE records, a synthetic XZZ conformance vector, and ZIPs made in memory with fflate' };
}

module.exports = { run };
