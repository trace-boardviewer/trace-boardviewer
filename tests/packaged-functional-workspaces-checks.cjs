'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { run, openWorkspace, assertOwnedBoard, fitBoard } = require('../scripts/packaged-functional/workspaces.cjs');

function contextWithout(method) {
  const context = {
    options: {}, fixtureDir: 'fixtures', profile: 'profile', root: 'root',
    getPage() {}, step() {}, registerFixture() {}, withOpenDialog() {}, withSaveDialog() {},
    waitBoard() {}, dismissSupport() {}, withProfile() {}, restart() {}, screenshot() {},
  };
  delete context[method];
  return context;
}

test('workspace native module exposes run and fails closed when a required helper is absent', async () => {
  assert.equal(typeof run, 'function');
  const calls = [];
  const context = contextWithout('getPage');
  context.registerFixture = (...args) => calls.push(args);
  await assert.rejects(run(context), /required native helper getPage exists/);
  assert.deepEqual(calls, [], 'fixture registration does not begin with an incomplete context');
});

test('workspace file chooser helpers are mandatory asynchronous contracts', async (t) => {
  for (const method of ['withOpenDialog', 'withSaveDialog']) {
    await t.test(`${method} is required before any native action`, async () => {
      const context = contextWithout(method);
      const calls = [];
      context.registerFixture = (...args) => calls.push(args);
      await assert.rejects(run(context), new RegExp(`required native helper ${method} exists`));
      assert.deepEqual(calls, [], 'no chooser workflow runs when its scoped dialog helper is absent');
    });
  }
});

function fakePage(headingTitle) {
  return {
    getByTestId() {
      return { waitFor: async () => {}, click: async () => {} };
    },
    locator() {
      return { waitFor: async () => {}, getAttribute: async () => headingTitle };
    },
  };
}

test('opening a native workspace enforces exact component, pin and net counts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-open-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const board = path.join(directory, 'Board.cad');
  await fs.writeFile(board, 'synthetic');
  const calls = [];
  const page = fakePage(board);
  const ctx = {
    withOpenDialog: async (files, action) => { calls.push(['dialog', files]); await action(); },
    waitBoard: async (expected) => {
      calls.push(['counts', expected]);
      return { components: expected.components, pins: expected.pins, nets: expected.nets, title: 'fixture heading', target: board };
    },
  };
  await openWorkspace(page, ctx, board);
  assert.deepEqual(calls, [
    ['dialog', [board]],
    ['counts', { components: 1, pins: 2, nets: 2, target: board }],
  ]);
});

test('opening a native workspace fails when the live board omits an expected net', async () => {
  const ctx = {
    withOpenDialog: async (_files, action) => action(),
    waitBoard: async () => ({ components: 1, pins: 2 }),
  };
  await assert.rejects(openWorkspace(fakePage(), ctx, 'fixture/Board.cad'), /exact fixture component, pin and net counts/);
});

test('restart identity compares the active project heading to the owned canonical file path', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-identity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owned = path.join(directory, 'Board.cad');
  const other = path.join(directory, 'Other.cad');
  await Promise.all([fs.writeFile(owned, 'owned'), fs.writeFile(other, 'other')]);
  await assertOwnedBoard(fakePage(owned), owned);
  await assert.rejects(assertOwnedBoard(fakePage(other), owned), /module-owned board by canonical path/);
});

test('pin coordinate lookup fit waits for the live 100% camera and canvas redraw', async () => {
  const calls = [];
  const page = {
    getByTestId(id) {
      assert.equal(id, 'fit-tool');
      return { waitFor: async () => {}, click: async () => calls.push('fit') };
    },
    waitForFunction: async (_predicate, _arg, options) => calls.push(['camera', options]),
    evaluate: async () => calls.push('redraw'),
  };
  await fitBoard(page);
  assert.deepEqual(calls, ['fit', ['camera', { timeout: 10000 }], 'redraw']);
});
