'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_SHA = '83ba92241dc94dd9ce307217096f254cb86bd289';
const OVERLAY = 'trace-native-qa-overlay/1';

function parseArgs(argv) {
  const values = new Map();
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' && !dryRun) { dryRun = true; continue; }
    const match = /^--(source|out)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error('Use --source=<exact v1.3.1 checkout> --out=<absolute manifest path>.');
    values.set(match[1], match[2]);
  }
  assert.equal(values.size, 2, 'source and out are required');
  assert.ok(path.isAbsolute(values.get('source')) && path.isAbsolute(values.get('out')), 'source and out paths must be absolute');
  return { source: path.resolve(values.get('source')), out: path.resolve(values.get('out')), dryRun };
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  assert.notEqual(first, -1, `${label}: expected published harness snippet is present`);
  assert.equal(text.indexOf(before, first + before.length), -1, `${label}: snippet is unique`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

async function prepareOverlay(source) {
  const operations = [
    {
      relative: 'scripts/linux-smoke.cjs',
      before: `  const repository = readJson(path.join(ROOT, 'electron', 'repository.json')).repository;\n  const bugUrl = \`https://github.com/\${repository}/issues/new?template=bug_report.yml\`;\n`,
      after: `  const supportUrl = 'https://trace-boardviewer.github.io/support.html';\n`,
      label: 'use the fixed public support URL from the published Electron main process',
    },
    {
      relative: 'scripts/linux-smoke.cjs',
      before: `    // openExternal: a check only when the stand-in received the call; if Electron used another path (an XDG portal), it is noted.\n    {\n      await fs.rm(dirs.xdgRecord, { force: true });\n      let opened = null;\n      let failure = null;\n      if (!aborted) {\n        try {\n          await page.evaluate(() => window.traceDesktop.openSupportLink('bug'));\n          opened = await waitFor(async () => (exists(dirs.xdgRecord) ? parseKeyValueLines(readText(dirs.xdgRecord)) : null), { timeoutMs: 15000, what: 'the stand-in xdg-open' }).catch(() => null);\n        } catch (error) { failure = error; }\n      }\n      if (failure) checks.push({ name: 'openExternal: the bug-report link is handed to the system', status: 'fail', detail: String(failure.message).slice(0, 500) });\n      else if (opened) {\n        runtime.openExternal = opened;\n        const ok = opened.url === bugUrl && opened.argc === '1';\n        checks.push({ name: 'openExternal: the bug-report link reaches xdg-open as exactly one https URL', status: ok ? 'pass' : 'fail', detail: ok ? opened.url : \`received \${JSON.stringify(opened)}, expected \${bugUrl}\` });\n        if (opened.ld_library_path !== undefined) observations.push(\`xdg-open inherited LD_LIBRARY_PATH=\${opened.ld_library_path}\`);\n      } else if (!aborted) observations.push('openExternal: the stand-in xdg-open received nothing within 15 s (Electron may have used the XDG portal); the link was not verified');\n    }\n`,
      after: `    // The bug-report action is deliberately an in-app flow; it must never be sent to xdg-open.\n    {\n      await fs.rm(dirs.xdgRecord, { force: true });\n      if (!aborted) {\n        await page.click('[data-testid=report-bug-button]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'visible', timeout: 15000 });\n        if (exists(dirs.xdgRecord)) throw new Error('the in-app bug-report action was handed to xdg-open');\n        await page.click('[data-testid=bug-report-cancel]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached', timeout: 15000 });\n        checks.push({ name: 'bug-report action opens the in-app form without an external handoff', status: 'pass' });\n      }\n    }\n`,
      label: 'Linux smoke checks the in-app bug-report action without treating it as an external URL',
    },
    {
      relative: 'scripts/linux-smoke.cjs',
      before: `    // The bug-report action is deliberately an in-app flow; it must never be sent to xdg-open.\n    {\n      await fs.rm(dirs.xdgRecord, { force: true });\n      if (!aborted) {\n        await page.click('[data-testid=report-bug-button]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'visible', timeout: 15000 });\n        if (exists(dirs.xdgRecord)) throw new Error('the in-app bug-report action was handed to xdg-open');\n        await page.click('[data-testid=bug-report-cancel]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached', timeout: 15000 });\n        checks.push({ name: 'bug-report action opens the in-app form without an external handoff', status: 'pass' });\n      }\n    }\n`,
      after: `    // The bug-report action is deliberately an in-app flow; it must never be sent to xdg-open.\n    {\n      await fs.rm(dirs.xdgRecord, { force: true });\n      if (!aborted) {\n        await page.click('[data-testid=report-bug-button]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'visible', timeout: 15000 });\n        if (exists(dirs.xdgRecord)) throw new Error('the in-app bug-report action was handed to xdg-open');\n        await page.click('[data-testid=bug-report-cancel]');\n        await page.waitForSelector('[data-testid=bug-report-dialog]', { state: 'detached', timeout: 15000 });\n        checks.push({ name: 'bug-report action opens the in-app form without an external handoff', status: 'pass' });\n      }\n    }\n    // Independently retain the valid external support-page check; Electron may use the XDG portal instead.\n    {\n      await fs.rm(dirs.xdgRecord, { force: true });\n      let opened = null;\n      let failure = null;\n      if (!aborted) {\n        try {\n          await page.evaluate(() => window.traceDesktop.openSupportLink('support'));\n          opened = await waitFor(async () => (exists(dirs.xdgRecord) ? parseKeyValueLines(readText(dirs.xdgRecord)) : null), { timeoutMs: 15000, what: 'the stand-in xdg-open for the public support page' }).catch(() => null);\n        } catch (error) { failure = error; }\n      }\n      if (failure) checks.push({ name: 'openExternal: the public support page is handed to the system', status: 'fail', detail: String(failure.message).slice(0, 500) });\n      else if (opened) {\n        runtime.openExternal = opened;\n        const ok = opened.url === supportUrl && opened.argc === '1';\n        checks.push({ name: 'openExternal: the public support page reaches xdg-open as exactly one https URL', status: ok ? 'pass' : 'fail', detail: ok ? opened.url : \`received \${JSON.stringify(opened)}, expected \${supportUrl}\` });\n        if (opened.ld_library_path !== undefined) observations.push(\`xdg-open inherited LD_LIBRARY_PATH=\${opened.ld_library_path}\`);\n      } else if (!aborted) observations.push('openExternal: the stand-in xdg-open received nothing within 15 s (Electron may have used the XDG portal); support-page URL handoff was not verified');\n    }\n`,
      label: 'Linux smoke retains valid public support URL handoff coverage after the in-app bug-report check',
    },
    {
      relative: 'scripts/packaged-functional-qa.cjs',
      before: `      await page.waitForFunction(() => /pins\\.asc/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20000 });\n      await page.fill('[data-testid=search-input]', 'U1');\n      await page.press('[data-testid=search-input]', 'Enter');\n`,
      after: `      await page.waitForFunction(() => /pins\\.asc/i.test(document.querySelector('.project-subtitle')?.textContent || ''), null, { timeout: 20000 });\n      // Restart can restore the old query while the new board's search is still pending. Start a fresh visible search before Enter.\n      await page.fill('[data-testid=search-input]', '');\n      await page.fill('[data-testid=search-input]', 'U1');\n      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=search-row][data-source="board-components"]')].some(row => /U1/.test(row.textContent || '')), null, { timeout: 15000 });\n      await page.press('[data-testid=search-input]', 'Enter');\n`,
      label: 'ASC companion QA waits for refreshed visible results before keyboard activation',
    },
    {
      relative: 'scripts/packaged-functional-qa.cjs',
      before: `      evidence.ocrAssetRuntimeProof = { assets: observedAssets, loadedFrom: 'resources/app.asar/dist/assets', archiveSha256: evidence.artifact.asarSha256 };\n      await page.fill('[data-testid=search-input]', 'PU301');\n      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=search-row]')].some((node) => /manual\\.pdf|document/i.test(node.textContent || '')), null, { timeout: 30000 });\n      assert.equal(await page.locator('.pdfv-error').count(), 0);\n      await screenshot('ocr-recognized');\n      await page.fill('[data-testid=search-input]', '');\n`,
      after: `      evidence.ocrAssetRuntimeProof = { assets: observedAssets, loadedFrom: 'resources/app.asar/dist/assets', archiveSha256: evidence.artifact.asarSha256 };\n      // Search is mounted in Board while the OCR viewer belongs to Documents; switch explicitly between them.\n      await page.click('#wsp-tab-board');\n      await page.waitForSelector('[data-testid=search-input]', { state: 'visible', timeout: 15000 });\n      await page.fill('[data-testid=search-input]', 'PU301');\n      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=search-row]')].some((node) => /manual\\.pdf|document/i.test(node.textContent || '')), null, { timeout: 30000 });\n      assert.equal(await page.locator('.pdfv-error').count(), 0);\n      await page.fill('[data-testid=search-input]', '');\n      await page.click('#wsp-tab-documents');\n      await page.waitForSelector('[data-testid=documents-tab] .pdfv-page[data-render=done]', { state: 'visible', timeout: 15000 });\n      await screenshot('ocr-recognized');\n`,
      label: 'macOS/Linux OCR QA selects Board for search, then Documents for OCR evidence',
    },
  ];

  const updated = new Map();
  for (const operation of operations) {
    const absolute = path.join(source, operation.relative);
    const text = updated.get(operation.relative) ?? await fs.readFile(absolute, 'utf8');
    updated.set(operation.relative, replaceOnce(text, operation.before, operation.after, operation.label));
  }

  const records = [];
  for (const [relative, text] of updated) {
    const absolute = path.join(source, relative);
    const original = await fs.readFile(absolute);
    records.push({ file: relative, originalSha256: sha256(original), overlaySha256: sha256(text), reason: operations.filter(f => f.relative === relative).map(f => f.label) });
  }
  return { updated, records };
}

async function apply({ source, out, dryRun = false }) {
  const commit = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, 'the exact source checkout is a Git worktree');
  assert.equal(commit.stdout.trim(), SOURCE_SHA, 'QA overlay applies only to the exact published v1.3.1 source');
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.3.1', 'published source package version is 1.3.1');
  const { updated, records } = await prepareOverlay(source);

  if (!dryRun) {
    // All expected snippets are verified before either QA file is written.
    for (const [relative, text] of updated) await fs.writeFile(path.join(source, relative), text, 'utf8');
  }
  const overlayScript = await fs.readFile(__filename);
  const manifest = {
    schema: OVERLAY,
    tag: 'v1.3.1',
    sourceSha: SOURCE_SHA,
    workflowSha: process.env.GITHUB_SHA || null,
    overlayScriptSha256: sha256(overlayScript),
    appBinaryChanged: false,
    dryRun,
    files: records,
  };
  if (dryRun) return manifest;
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

if (require.main === module) {
  apply(parseArgs(process.argv)).then((manifest) => {
    for (const file of manifest.files) console.log(`${file.file} original=${file.originalSha256} overlay=${file.overlaySha256}`);
    console.log(`workflowSha=${manifest.workflowSha || 'unavailable'} overlayScriptSha256=${manifest.overlayScriptSha256} dryRun=${manifest.dryRun}`);
  }).catch((error) => { console.error(`Native QA overlay failed closed: ${error.message}`); process.exitCode = 1; });
}

module.exports = Object.freeze({ apply, parseArgs, prepareOverlay, replaceOnce });
