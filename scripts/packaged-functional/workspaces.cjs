'use strict';

// Native UI checks for saved workspace documents, technician notes and shell settings.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { unzipSync } = require('fflate');
const { makeImageOnlyPdf } = require('../qa-ocr.cjs');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const boardText = () => '$HEADER\nGENCAD 1.4\nUNITS MM\nORIGIN 0 0\n$ENDHEADER\n$BOARD\nRECTANGLE 0 0 40 30\n$ENDBOARD\n$PADS\nPAD P ROUND -1\nCIRCLE 0 0 0.2\n$ENDPADS\n$PADSTACKS\nPADSTACK PS 0\nPAD P TOP 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE S\nRECTANGLE -2 -1 4 2\nPIN 1 PS -1 0 TOP 0 0\nPIN 2 PS 1 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT U1\nPLACE 20 20\nLAYER TOP\nROTATION 0\nSHAPE S 0 0\nDEVICE D\n$ENDCOMPONENTS\n$DEVICES\nDEVICE D\nVALUE "10k"\n$ENDDEVICES\n$SIGNALS\nSIGNAL GND\nNODE U1 1\nSIGNAL VCC\nNODE U1 2\n$ENDSIGNALS\n';

// Small deterministic PNG fixtures; both workspace docs differ by content and Unicode/case-sensitive names.
function pngPixel(red, green, blue) {
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0, red, green, blue]))), chunk('IEND', Buffer.alloc(0))]);
}
const png = pngPixel(30, 60, 90);
const pngAlt = pngPixel(90, 60, 30);
const pdf = makeImageOnlyPdf(['SYNTHETIC']);

function testId(page, id) { return page.getByTestId(id); }
async function requireVisible(page, id) {
  const locator = testId(page, id);
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  return locator;
}
async function clickVisible(page, id) {
  const locator = await requireVisible(page, id);
  await locator.click();
}
async function openWorkspace(page, ctx, board) {
  await ctx.withOpenDialog([board], async () => clickVisible(page, 'open-board'));
  const result = await ctx.waitBoard({ components: 1, pins: 2, nets: 2, target: board });
  const counts = { components: result.components, pins: result.pins, nets: result.nets };
  assert.deepEqual(counts, { components: 1, pins: 2, nets: 2 }, 'the opened native board has the exact fixture component, pin and net counts');
  await requireVisible(page, 'search-input');
  await assertOwnedBoard(page, board);
}
function normalizeNativePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
async function assertOwnedBoard(page, board) {
  const heading = page.locator('.project-heading');
  await heading.waitFor({ state: 'visible', timeout: 10000 });
  const title = await heading.getAttribute('title');
  assert.ok(title, 'the active project heading exposes a source path');
  const actual = await fs.realpath(title);
  const expected = await fs.realpath(board);
  assert.equal(normalizeNativePath(actual), normalizeNativePath(expected), 'the active project heading identifies this module-owned board by canonical path');
}
async function selectReference(page, ref) {
  const input = await requireVisible(page, 'search-input');
  await input.fill(ref);
  const row = page.getByTestId('search-row').filter({ hasText: ref });
  await row.first().waitFor({ state: 'visible', timeout: 10000 });
  await row.first().click();
  await page.getByTestId('hero-ref').filter({ hasText: ref }).waitFor({ state: 'visible', timeout: 10000 });
}
async function fitBoard(page) {
  await clickVisible(page, 'fit-tool');
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-value"]')?.textContent?.trim() === '100%', null, { timeout: 10000 });
  // The camera status is published by the rendered canvas; let its redraw complete before using fit-derived coordinates.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function findRenderedPin(page, number) {
  const canvas = page.locator('canvas.board-canvas');
  await canvas.waitFor({ state: 'visible', timeout: 10000 });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, 'board canvas has measurable native viewport geometry');
  // Estimate the fit scale from the known synthetic board boundary, then probe around the requested pin's fixture coordinate.
  const scale = Math.min(Math.max(1, box.width - 120) / 40, Math.max(1, box.height - 120) / 30);
  const target = { x: box.x + box.width / 2 + (number === 1 ? -1 : 1) * scale, y: box.y + box.height / 2 - 5 * scale };
  const radius = Math.max(8, scale * 1.5);
  for (let y = target.y - radius; y <= target.y + radius; y += 3) {
    for (let x = target.x - radius; x <= target.x + radius; x += 3) {
      await page.mouse.move(x, y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const label = page.locator('.canvas-hover-card').first();
      if (await label.count()) {
        const text = await label.innerText();
        if (new RegExp(`\\bU1\\s*·\\s*${number}\\b`).test(text)) return { x, y, text };
      }
    }
  }
  assert.fail(`rendered board geometry did not expose pin ${number} as a hit target`);
}
async function readStoreFiles(profile, directory) {
  const folder = path.join(profile, directory);
  const names = await fs.readdir(folder).catch((error) => error && error.code === 'ENOENT' ? [] : Promise.reject(error));
  return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => ({
    name, bytes: await fs.readFile(path.join(folder, name)), value: JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')),
  })));
}

async function run(ctx) {
  assert.ok(ctx && ctx.options && ctx.fixtureDir && ctx.profile && ctx.root, 'native module context is complete');
  for (const method of ['getPage', 'step', 'registerFixture', 'withOpenDialog', 'withSaveDialog', 'waitBoard', 'dismissSupport', 'withProfile', 'restart', 'screenshot']) {
    assert.equal(typeof ctx[method], 'function', `required native helper ${method} exists`);
  }
  const board = await ctx.registerFixture('stable-workspaces/Board.cad', Buffer.from(boardText(), 'utf8'));
  const pngName = 'Σervice/Mánual.png';
  const pngCaseName = 'Service/mánual.png';
  const firstDoc = await ctx.registerFixture(`stable-workspaces/${pngName}`, png);
  const caseDoc = await ctx.registerFixture(`stable-workspaces/${pngCaseName}`, pngAlt);
  const pdfDoc = await ctx.registerFixture('stable-workspaces/Ω-repair.pdf', pdf);
  const initialHashes = new Map([[board, sha256(Buffer.from(boardText(), 'utf8'))], [firstDoc, sha256(png)], [caseDoc, sha256(pngAlt)], [pdfDoc, sha256(pdf)]]);
  let page = ctx.getPage();
  await ctx.dismissSupport();

  await ctx.step('open synthetic board and attach workspace documents', async () => {
    await openWorkspace(page, ctx, board);
    await clickVisible(page, 'tab-documents');
    await ctx.withOpenDialog([firstDoc, caseDoc, pdfDoc], async () => clickVisible(page, 'attach'));
    await page.getByTestId('document-row').filter({ hasText: path.basename(pngName) }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByTestId('document-row').filter({ hasText: path.basename(pngCaseName) }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByTestId('document-row').filter({ hasText: 'Ω-repair.pdf' }).waitFor({ state: 'visible', timeout: 15000 });
    const docs = await page.getByTestId('document-row').evaluateAll((rows) => rows.map((row) => ({
      name: row.querySelector('.wsp-doc-title')?.textContent?.trim(), status: row.getAttribute('data-status'),
    })));
    assert.equal(docs.length, 3, 'each explicitly selected document is attached once');
    assert.equal(new Set(docs.map((doc) => doc.name)).size, 3, 'Unicode and case-distinct documents remain distinct');
    assert.deepEqual(docs.map((doc) => doc.name).sort(), [path.basename(pngName), path.basename(pngCaseName), 'Ω-repair.pdf'].sort(), 'rows display the stored basenames');
    assert.ok(docs.every((doc) => doc.status === 'ready'), 'all attached synthetic documents have unchanged hashes');
    return { documentNames: docs.map((doc) => doc.name), sourceHashes: [...initialHashes.values()] };
  });

  await ctx.step('missing and changed documents require explicit relink or acceptance', async () => {
    const original = Buffer.from(png);
    try {
      await fs.unlink(firstDoc);
      await ctx.restart();
      page = ctx.getPage();
      await ctx.dismissSupport();
      await clickVisible(page, 'tab-documents');
      const firstRow = page.getByTestId('document-row').filter({ hasText: path.basename(pngName) });
      await firstRow.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await firstRow.getAttribute('data-status'), 'missing', 'a missing workspace document is identified without dropping its record');
      await fs.writeFile(firstDoc, original);
      assert.deepEqual(await fs.readFile(firstDoc), original, 'the original bytes are restored before the native relink action begins');
      await ctx.withOpenDialog([firstDoc], async () => firstRow.getByTestId('relink-row').click());
      await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="document-row"]')].some((row) => row.textContent.includes(name) && row.getAttribute('data-status') === 'ready'), path.basename(pngName), { timeout: 15000 });

      await fs.writeFile(firstDoc, pngAlt);
      await ctx.restart();
      page = ctx.getPage();
      await ctx.dismissSupport();
      await clickVisible(page, 'tab-documents');
      const changedRow = page.getByTestId('document-row').filter({ hasText: path.basename(pngName) });
      await changedRow.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await changedRow.getAttribute('data-status'), 'changed', 'a byte hash change is shown before the workspace adopts it');
      await changedRow.getByTestId('accept-row').click();
      await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="document-row"]')].some((row) => row.textContent.includes(name) && row.getAttribute('data-status') === 'ready'), path.basename(pngName), { timeout: 15000 });

      // Restore the original synthetic input and explicitly accept that exact hash as the new workspace state.
      await fs.writeFile(firstDoc, original);
      await ctx.restart();
      page = ctx.getPage();
      await ctx.dismissSupport();
      await clickVisible(page, 'tab-documents');
      const restoredRow = page.getByTestId('document-row').filter({ hasText: path.basename(pngName) });
      await restoredRow.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await restoredRow.getAttribute('data-status'), 'changed', 'restoring different bytes is detected after restart');
      await restoredRow.getByTestId('accept-row').click();
      await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="document-row"]')].some((row) => row.textContent.includes(name) && row.getAttribute('data-status') === 'ready'), path.basename(pngName), { timeout: 15000 });
      assert.deepEqual(await fs.readFile(firstDoc), original, 'original registered fixture bytes are restored');
      return { missingDetected: true, relinked: true, changedHashHeldForAcceptance: true, originalFixtureRestored: true };
    } finally {
      await fs.writeFile(firstDoc, original);
    }
  });

  await ctx.step('select a geometric pin and enter component and pin notes', async () => {
    await clickVisible(page, 'tab-board');
    await selectReference(page, 'U1');
    await fitBoard(page);
    const pin = await findRenderedPin(page, 1);
    await page.mouse.click(pin.x, pin.y);
    const pinRow = page.getByTestId('pin-row').filter({ hasText: /^1/ }).first();
    await pinRow.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await pinRow.getAttribute('aria-pressed'), 'true', 'canvas hit testing selected the rendered pad for pin 1');
    await testId(page, 'add-note').click();
    await requireVisible(page, 'note-dialog');
    await page.locator('#note-draft').fill('Synthetic pin observation');
    await testId(page, 'measure-voltage').fill('1.8 V');
    await testId(page, 'measure-resistance').fill('0.4 Ω');
    await testId(page, 'note-save').click();
    await page.getByTestId('note-dialog').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await page.getByTestId('note-card').count(), 1, 'pin note is visible after save');
    await requireVisible(page, 'tab-board');
    await selectReference(page, 'U1');
    await testId(page, 'add-note').click();
    await requireVisible(page, 'note-dialog');
    await page.locator('#note-draft').fill('Synthetic component inspection');
    await testId(page, 'measure-voltage').fill('3.3 V');
    await testId(page, 'measure-resistance').fill('4.7 kΩ to GND');
    await testId(page, 'note-save').click();
    await page.getByTestId('note-dialog').waitFor({ state: 'detached', timeout: 10000 });
    const notes = await readStoreFiles(ctx.profile, 'notes');
    const serialized = notes.flatMap((entry) => Array.isArray(entry.value) ? entry.value : []);
    assert.ok(serialized.some((note) => note.text === 'Synthetic component inspection' && note.measurements?.voltage === '3.3 V' && note.measurements?.resistance === '4.7 kΩ to GND'), 'typed component readings are serialized in the native profile');
    assert.ok(serialized.some((note) => note.text === 'Synthetic pin observation' && note.measurements?.voltage === '1.8 V' && note.measurements?.resistance === '0.4 Ω'), 'typed pin readings are serialized separately');
    await ctx.screenshot('stable-workspaces-pin-note');
    return { storedNoteCount: serialized.length, pinTarget: serialized.find((note) => note.text === 'Synthetic pin observation')?.target ?? null };
  });

  await ctx.step('edit and delete a component note without removing its pin note', async () => {
    await selectReference(page, 'U1');
    const edit = page.getByRole('button', { name: /Edit note/i }).first();
    await edit.click();
    await requireVisible(page, 'note-dialog');
    await page.locator('#note-draft').fill('Synthetic component inspection revised');
    await testId(page, 'measure-voltage').fill('3.1 V');
    await testId(page, 'note-save').click();
    await page.getByTestId('note-dialog').waitFor({ state: 'detached', timeout: 10000 });
    await selectReference(page, 'U1');
    await page.getByRole('button', { name: /Edit note/i }).first().click();
    await requireVisible(page, 'note-dialog');
    await testId(page, 'note-delete').click();
    await page.getByTestId('note-dialog').waitFor({ state: 'detached', timeout: 10000 });
    const notes = (await readStoreFiles(ctx.profile, 'notes')).flatMap((entry) => Array.isArray(entry.value) ? entry.value : []);
    assert.ok(!notes.some((note) => note.text === 'Synthetic component inspection revised'), 'component note deletion reaches the native store');
    assert.ok(notes.some((note) => note.text === 'Synthetic pin observation'), 'deleting the component note preserves the independent pin note');
    return { remainingSyntheticPinNote: true };
  });

  await ctx.step('measure board geometry and exercise settings UI', async () => {
    await clickVisible(page, 'tab-board');
    await selectReference(page, 'U1');
    await fitBoard(page);
    const firstPad = await findRenderedPin(page, 1);
    const secondPad = await findRenderedPin(page, 2);
    assert.match(firstPad.text, /\bU1\s*·\s*1\b/, 'first fixture pad identity is proven by hover before entering measurement mode');
    assert.match(secondPad.text, /\bU1\s*·\s*2\b/, 'second fixture pad identity is proven by hover before entering measurement mode');
    const canvas = page.locator('canvas.board-canvas');
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 100 && box.height > 100, 'measurement canvas has nonzero geometry');
    await clickVisible(page, 'measure-tool');
    await page.mouse.click(firstPad.x, firstPad.y);
    await page.mouse.click(secondPad.x, secondPad.y);
    const measured = testId(page, 'status-measure');
    await measured.waitFor({ state: 'visible', timeout: 10000 });
    const measureText = await measured.innerText();
    const distance = Number(measureText.match(/([\d.,]+)\s*mm/)?.[1]?.replace(',', '.'));
    assert.ok(Number.isFinite(distance) && Math.abs(distance - 2) <= 0.15, `known 2 mm fixture pad spacing is measured within 0.15 mm (actual ${measureText})`);
    await page.getByRole('button', { name: /finish measurement/i }).click();
    await clickVisible(page, 'settings-button');
    await requireVisible(page, 'settings-dialog');
    await page.locator('.settings-options').nth(1).locator('button').nth(1).click();
    await testId(page, 'language-select').selectOption('uk');
    await testId(page, 'theme-light').click();
    const switches = page.getByRole('switch');
    assert.ok(await switches.count() >= 3, 'motion, labels, and connections switches are present');
    await switches.nth(1).uncheck();
    await switches.nth(2).uncheck();
    await clickVisible(page, 'network-activity-toggle');
    await requireVisible(page, 'network-log');
    await clickVisible(page, 'network-refresh');
    await requireVisible(page, 'network-clear');
    assert.equal(await page.locator('[data-testid="app"]').getAttribute('data-theme-mode'), 'light', 'theme change reaches the live application');
    assert.ok(await page.locator('[data-testid="app"]').evaluate((app) => app.classList.contains('focus-mode')), 'layout change reaches the live application');
    assert.equal(await switches.nth(1).isChecked(), false, 'label visibility is disabled in the live settings');
    assert.equal(await switches.nth(2).isChecked(), false, 'connection visibility is disabled in the live settings');
    await page.getByTestId('settings-dialog').locator('.modal-footer button').click();
    await page.getByTestId('settings-dialog').waitFor({ state: 'detached', timeout: 10000 });
    return { measurement: measureText, settings: { language: 'uk', theme: 'light', layout: 'focus', showLabels: false, showConnections: false }, activityOpened: true };
  });

  await ctx.step('selectively export workspace with native save dialog scoped to the test profile', async () => {
    page = ctx.getPage();
    // The test harness invokes this only in the packaged main process and restores it with the launch context.
    const destination = path.join(ctx.root, 'stable-workspaces-export.zip');
    await clickVisible(page, 'tab-documents');
    await clickVisible(page, 'export-open');
    await requireVisible(page, 'export-dialog');
    const docs = page.getByTestId('export-doc');
    assert.equal(await docs.count(), 3, 'export lists the three workspace documents');
    await docs.nth(0).check();
    await testId(page, 'export-notes').check();
    assert.match(await testId(page, 'export-summary').innerText(), /1 document/);
    await ctx.withSaveDialog(destination, async () => testId(page, 'export-run').click());
    await requireVisible(page, 'export-result');
    const bytes = await fs.readFile(destination);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'selected workspace bundle is a ZIP written by the native exporter');
    const digest = sha256(bytes);
    const archive = unzipSync(bytes);
    const entries = Object.keys(archive);
    assert.ok(entries.some((name) => name.endsWith(path.basename(pngName))), 'bundle includes the selected synthetic document');
    assert.ok(!entries.some((name) => name.endsWith(path.basename(pngCaseName))) && !entries.some((name) => name.endsWith('Ω-repair.pdf')), 'unchecked documents are not included implicitly');
    assert.ok(entries.includes('notes.json'), 'notes are included only because the notes option was selected');
    const exportedNotes = JSON.parse(Buffer.from(archive['notes.json']).toString('utf8'));
    assert.ok(exportedNotes.some((note) => note.text === 'Synthetic pin observation' && note.measurements?.resistance === '0.4 Ω'), 'exported notes contain the saved synthetic pin measurement');
    return { bytes: bytes.length, sha256: digest, selectedDocuments: 1, includeNotes: true, includeBoard: false, entries };
  });

  await ctx.step('restart preserves workspace, notes and settings; a second profile stays isolated', async () => {
    await ctx.restart();
    page = ctx.getPage();
    await ctx.dismissSupport();
    await requireVisible(page, 'app');
    assert.equal(await page.locator('[data-testid="app"]').getAttribute('data-theme-mode'), 'light', 'theme survived normal restart');
    assert.equal(await testId(page, 'settings-button').count(), 1, 'native application remains responsive after restart');
    const manifestFiles = await readStoreFiles(ctx.profile, 'workspaces');
    const manifests = manifestFiles.map((entry) => entry.value);
    assert.ok(manifests.some((manifest) => manifest.documents?.length === 3 && manifest.documents.some((doc) => doc.name === path.basename(pngName)) && manifest.documents.some((doc) => doc.name === path.basename(pngCaseName))), 'serialized workspace preserves both Unicode/case-distinct basenames without crossing identities');
    const manifest = manifests.find((candidate) => candidate.documents?.length === 3);
    assert.equal(manifest.documents.find((doc) => doc.name === path.basename(pngName))?.key, sha256(png), 'workspace identity is the actual original document byte hash');
    assert.equal(manifest.documents.find((doc) => doc.name === path.basename(pngCaseName))?.key, sha256(pngAlt), 'case-distinct document identity keeps its own actual byte hash');
    const noteFiles = await readStoreFiles(ctx.profile, 'notes');
    const notes = noteFiles.flatMap((entry) => Array.isArray(entry.value) ? entry.value : []);
    assert.ok(notes.some((note) => note.text === 'Synthetic pin observation' && note.measurements?.voltage === '1.8 V'), 'pin note round-trips through normal quit and restart');
    assert.ok(!notes.some((note) => note.text === 'Synthetic component inspection revised'), 'deleted component note stays deleted after restart');
    const settings = JSON.parse(await fs.readFile(path.join(ctx.profile, 'config.json'), 'utf8')).settings;
    assert.deepEqual({ language: settings.language, theme: settings.theme, layout: settings.layout, showLabels: settings.showLabels, showConnections: settings.showConnections },
      { language: 'uk', theme: 'light', layout: 'focus', showLabels: false, showConnections: false }, 'native config serialization preserves all selected settings');
    const ownedWorkspace = manifests.find((candidate) => candidate.documents?.length === 3);
    assert.ok(ownedWorkspace?.board?.key && ownedWorkspace.board.name === path.basename(board), 'test identifies its saved workspace by this board key and basename');
    await assertOwnedBoard(page, board);
    await clickVisible(page, 'settings-button');
    await requireVisible(page, 'settings-dialog');
    assert.equal(await testId(page, 'language-select').inputValue(), 'uk', 'language survived normal restart');
    assert.equal(await testId(page, 'theme-light').getAttribute('aria-pressed'), 'true', 'theme survived normal restart');
    assert.equal(await page.locator('.settings-options').nth(1).locator('button').nth(1).getAttribute('aria-pressed'), 'true', 'layout survived normal restart');
    const persistedSwitches = page.getByRole('switch');
    assert.equal(await persistedSwitches.nth(1).isChecked(), false, 'label preference survived normal restart');
    assert.equal(await persistedSwitches.nth(2).isChecked(), false, 'connection preference survived normal restart');
    await page.getByTestId('settings-dialog').locator('.modal-footer button').click();

    const isolated = path.join(ctx.root, 'stable-workspaces-profile-b');
    await ctx.withProfile(isolated, async () => {
      page = ctx.getPage();
      await ctx.dismissSupport();
      await openWorkspace(page, ctx, board);
      const isolatedNotes = await readStoreFiles(isolated, 'notes');
      assert.equal(isolatedNotes.flatMap((entry) => Array.isArray(entry.value) ? entry.value : []).length, 0, 'isolated profile does not inherit notes');
      await clickVisible(page, 'settings-button');
      await requireVisible(page, 'settings-dialog');
      assert.notEqual(await testId(page, 'language-select').inputValue(), 'uk', 'isolated profile does not inherit language preference');
      assert.notEqual(await testId(page, 'theme-light').getAttribute('aria-pressed'), 'true', 'isolated profile does not inherit theme preference');
      await testId(page, 'theme-dark').click();
      await testId(page, 'language-select').selectOption('en');
      await page.getByTestId('settings-dialog').locator('.modal-footer button').click();
    });
    page = ctx.getPage();
    await requireVisible(page, 'app');
    assert.equal(await page.locator('[data-testid="app"]').getAttribute('data-theme-mode'), 'light', 'returning to the original profile restores its settings');
    return { originalNoteCount: notes.length, manifestDocuments: ownedWorkspace?.documents?.length ?? 0, isolatedNotes: 0, originalProfileRestored: true };
  });

  const changed = [];
  for (const [file, expected] of initialHashes) {
    const bytes = await fs.readFile(file);
    changed.push({ file, expected, actual: sha256(bytes) });
  }
  assert.ok(changed.every((entry) => entry.actual === entry.expected), 'all registered synthetic source fixtures retain their original bytes');
  return { module: 'workspaces', steps: ['document attach and identity', 'geometric pin note', 'note edit and delete', 'board distance and settings', 'selective workspace export', 'restart and profile isolation'], fixtureHashes: changed.map(({ expected }) => expected) };
}

module.exports = { run, boardText, openWorkspace, assertOwnedBoard, normalizeNativePath, fitBoard };
