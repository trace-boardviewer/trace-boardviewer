'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../scripts/packaged-functional/imports.cjs');

function locator(selector, currentPath, pageState) {
  let textReads = 0;
  return {
    async waitFor({ state } = {}) {
      if (selector === '[data-testid="support-notice"]' && state === 'visible') {
        assert.ok(pageState.supportVisible, 'the post-restart support notice has actually become visible');
        pageState.events.push('support-visible');
      }
      if (selector === '[data-testid="support-notice"]' && state === 'hidden') assert.equal(pageState.supportVisible, false, 'the normal support skip closed the notice');
      if (selector === '.toast.error' && state === 'visible') assert.ok(pageState.errorToast, 'a current refusal toast is visible');
      if (selector === '.toast.error' && state === 'detached') assert.equal(pageState.errorToast, '', 'the previous refusal toast was dismissed');
    },
    async isVisible() {
      if (selector === '[data-testid="support-notice"]') return pageState.supportVisible;
      return selector === '.toast.error' ? Boolean(pageState.errorToast) : true;
    },
    async textContent() {
      if (selector === '.toast.error') return pageState.errorToast;
      if (selector === '[data-testid="key-dialog"]') return `${path.basename(pageState.pendingPath || currentPath())}: synthetic key request ${++textReads}`;
      return `synthetic status ${selector} ${++textReads}`;
    },
    async getAttribute() { return selector === '.project-heading' ? currentPath() : null; },
    async click() {
      if (selector === '[data-testid="key-submit"]' && pageState.keyValue === '0103030505060909') pageState.commitPath(pageState.pendingPath);
      if (selector === '[data-testid="support-not-now"]') {
        assert.ok(pageState.supportVisible, 'the support notice is visibly dismissible');
        pageState.supportVisible = false;
        pageState.events.push('support-skip');
      }
    },
    async fill(value) { if (selector === '#board-key') pageState.keyValue = value; },
    async count() { return selector === '.toast.error' && pageState.errorToast ? 1 : 0; },
    first() { return this; },
    async evaluateAll() { if (selector === '.toast.error button') pageState.errorToast = ''; return []; },
  };
}

test('native import module follows the packaged functional context contract and registers immutable synthetic fixtures', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-native-imports-'));
  const calls = { steps: [], open: [], boards: [], screenshots: [], restarts: 0, fixtures: [] };
  const pageState = { errorToast: '', pendingPath: '', keyValue: '', supportVisible: false, events: [] };
  let currentPath = '';
  pageState.commitPath = (filePath) => { currentPath = filePath; };
  const createPage = () => ({ locator: (selector) => locator(selector, () => currentPath, pageState), async waitForFunction() {} });
  let page = createPage();
  const ctx = {
    fixtureDir,
    async step(name, action) { calls.steps.push(name); return action(); },
    async registerFixture(relativeName, content) {
      assert.ok(content instanceof Uint8Array, 'the asynchronous fixture helper receives byte arrays from the module');
      const absolute = path.resolve(fixtureDir, relativeName);
      assert.ok(absolute.startsWith(fixtureDir + path.sep), 'fixture stays under the private temporary root');
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, { flag: 'wx' });
      const fixtureBytes = fs.readFileSync(absolute);
      calls.fixtures.push({ relativeName, bytes: fixtureBytes.length, data: fixtureBytes });
      return absolute;
    },
    async openFiles(paths) {
      calls.open.push(paths);
      if (calls.restarts > 0 && paths[0].endsWith('synthetic-user-key.pcb')) {
        assert.equal(pageState.supportVisible, false, 'native open after restart waits until the visible notice is dismissed');
        pageState.events.push('post-restart-open');
      }
      if (paths[0].includes('unsafe-path.zip')) { pageState.errorToast = 'Unsafe archive path was rejected.'; return; }
      if (paths[0].includes('ambiguous-boards.zip')) { pageState.errorToast = 'Archive contains more than one board; none was opened.'; return; }
      if (paths[0].endsWith('synthetic-user-key.pcb')) { pageState.pendingPath = paths[0]; pageState.keyValue = ''; return; }
      currentPath = paths[0];
    },
    async waitBoard(expected) { calls.boards.push(expected); },
    getPage() { return page; },
    async screenshot(label) { calls.screenshots.push(label); },
    async restart() { calls.restarts++; pageState.supportVisible = true; page = createPage(); },
    async dismissSupport() {
      assert.equal(calls.restarts, 1, 'the normal support dismissal is scoped to the restarted active page');
      assert.ok(pageState.supportVisible, 'the actual synthetic support notice is visible before invoking the normal skip');
      await page.locator('[data-testid="support-not-now"]').click();
    },
  };

  try {
    const result = await run(ctx);
    assert.equal(result.module, 'imports');
    assert.ok(calls.steps.length >= 7, 'all required import scenarios are recorded as assertion steps');
    assert.ok(calls.open.length >= 10, 'native open workflow is exercised repeatedly');
    assert.ok(calls.boards.some((shape) => shape.components === 1 && shape.pins === 2 && shape.nets === 1));
    assert.ok(calls.boards.some((shape) => shape.components === 2 && shape.pins === 4 && shape.nets === 2));
    assert.ok(calls.screenshots.includes('imports-xzz-user-key'));
    assert.equal(calls.restarts, 1, 'session key is checked across a normal harness restart');
    assert.deepEqual(pageState.events.slice(-3), ['support-visible', 'support-skip', 'post-restart-open'], 'restart flow waits for the visible support notice, uses its ordinary skip, then opens XZZ');
    assert.equal(calls.fixtures.length, result.fixtureCount);
    assert.ok(calls.fixtures.every((fixture) => fixture.bytes > 0));
    assert.ok(calls.open.flat().some((filePath) => path.basename(filePath).includes('cafe\u0301')));
    assert.ok(calls.fixtures.some(({ relativeName }) => relativeName.endsWith('synthetic-user-key.pcb')));

    const { createServer } = await import('vite');
    const server = await createServer({ configFile: path.resolve(__dirname, '../vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
    try {
      const { parseBoardDetailed } = await server.ssrLoadModule('/src/lib/formats/dispatch.ts');
      const fixtures = new Map(calls.fixtures.map((fixture) => [fixture.relativeName.replaceAll('\\', '/'), fixture.data]));
      const parse = (relativeName, options = {}) => {
        const data = fixtures.get(relativeName);
        assert.ok(data, `the module registered ${relativeName}`);
        return parseBoardDetailed({ name: path.posix.basename(relativeName), data, ...options });
      };
      const assertBoard = (result, format, refs, pins, nets) => {
        assert.equal(result.adapter, format);
        assert.deepEqual(result.board.components.map((component) => component.ref).sort(), refs);
        assert.equal(result.board.pins.length, pins);
        assert.equal(result.board.nets.length, nets);
      };

      const capturedGenCadCases = ['unicode/board café #50%.cad', 'unicode/board cafe\u0301 #50%.cad', 'case/Board.cad', 'case/board.cad'];
      const assertCapturedGenCad = (relativeName, fixtureSet) => {
        const expectedRefs = relativeName === 'case/board.cad' ? ['R2'] : ['R1'];
        assertBoard(parseFrom(fixtureSet, relativeName), 'gencad', expectedRefs, 2, 1);
      };
      const parseFrom = (fixtureSet, relativeName, options = {}) => {
        const data = fixtureSet.get(relativeName);
        assert.ok(data, `the captured fixture set contains ${relativeName}`);
        return parseBoardDetailed({ name: path.posix.basename(relativeName), data, ...options });
      };
      for (const relativeName of capturedGenCadCases) {
        if (!fixtures.has(relativeName)) continue;
        assertCapturedGenCad(relativeName, fixtures);
      }

      const simulatedCaseSensitiveFixtures = new Map(fixtures);
      const upperCaseFixture = simulatedCaseSensitiveFixtures.get('case/Board.cad');
      assert.ok(upperCaseFixture, 'the captured fixture set contains the upper-case case twin');
      simulatedCaseSensitiveFixtures.set('case/board.cad', Buffer.from(upperCaseFixture.toString('utf8')
        .replace('COMPONENT R1', 'COMPONENT R2')
        .replace('NODE R1 1', 'NODE R2 1')));
      assertCapturedGenCad('case/Board.cad', simulatedCaseSensitiveFixtures);
      assertCapturedGenCad('case/board.cad', simulatedCaseSensitiveFixtures);
      assertBoard(parse('archives/unicode-entries.zip'), 'gencad', ['R1'], 2, 1);
      assertBoard(parse('archives/unicode-asc-companions.zip'), 'asc', ['U1'], 1, 1);
      for (const primary of ['format.asc', 'pins.asc', 'nails.asc']) {
        const companions = Object.fromEntries(['format.asc', 'pins.asc', 'nails.asc']
          .filter((name) => name !== primary)
          .map((name) => [name, fixtures.get(`asc/${name}`)]));
        assertBoard(parse(`asc/${primary}`, { companions }), 'asc', ['U1'], 1, 1);
      }
      for (const relativeName of ['archives/unsafe-path.zip', 'archives/ambiguous-boards.zip']) {
        const data = fixtures.get(relativeName);
        assert.ok(data, `the module registered ${relativeName}`);
        assert.throws(() => parseBoardDetailed({ name: path.posix.basename(relativeName), data }), `${relativeName} must be rejected by the real decoder`);
      }

      const xzz = fixtures.get('keys/synthetic-user-key.pcb');
      assert.ok(xzz, 'the XZZ decoder receives the exact bytes registered for the native import scenario');
      assert.throws(() => parseBoardDetailed({ name: 'synthetic-user-key.pcb', data: xzz }), (error) => error.code === 'KEY_REQUIRED');
      assert.throws(() => parseBoardDetailed({ name: 'synthetic-user-key.pcb', data: xzz, options: { xzzKey: '010f0c0a05030606' } }), (error) => error.code === 'INVALID_KEY');
      assertBoard(parseBoardDetailed({ name: 'synthetic-user-key.pcb', data: xzz, options: { xzzKey: '0103030505060909' } }), 'xzz', ['R1', 'U1'], 4, 2);

      for (const [relativeName, format] of [['keys/synthetic-base-key.fz', 'fz'], ['keys/synthetic-base-key.cae', 'fz']]) {
        assertBoard(parse(relativeName), format, ['U1'], 1, 1);
      }
    } finally {
      await server.close();
    }
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native import module fails closed when a required harness helper is absent', async () => {
  await assert.rejects(() => run({ fixtureDir: os.tmpdir() }), /requires ctx\.step\(\)/);
  await assert.rejects(() => run({ fixtureDir: os.tmpdir(), step() {}, registerFixture() {}, openFiles() {}, waitBoard() {}, getPage() {}, screenshot() {}, restart() {} }), /requires ctx\.dismissSupport\(\)/);
});
