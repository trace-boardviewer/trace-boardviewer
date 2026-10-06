'use strict';

// Native tests (no Electron) for the technician-workspace modules: identity.cjs (board key, path
// identity), workspace.cjs (manifest and notes validators), documents.cjs (content sniffing, bounded
// reads, selections, locating remembered documents, the export bundle). All fixtures are original
// synthetic data written here; the zip contents are inspected with fflate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fflate = require('fflate');
const identity = require('../electron/identity.cjs');
const workspace = require('../electron/workspace.cjs');
const documents = require('../electron/documents.cjs');
const { createByteBudget } = require('../electron/store.cjs');
const { isInsideTemp, makeTempDir } = require('./canonical-temp.cjs');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (ready, limit = 200) => { for (let attempt = 0; attempt < limit && !ready(); attempt++) await sleep(5); };
const KEY = 'a'.repeat(64);
const NOW = '2026-03-04T05:06:07.000Z';

async function sandbox(t0, label) {
  const root = await makeTempDir(`trace-ws-${label}-`);
  t0.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(await isInsideTemp(absolute));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}

const PDF = Buffer.from('%PDF-1.4\n% synthetic reference page\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic jpeg body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const KICAD_SCH = '(kicad_sch (version 20230121) (generator "synthetic"))\n';
const LEGACY_SCH = 'EESchema Schematic File Version 4\nEELAYER 30 0\nEELAYER END\n';
const LEGACY_LIB = 'EESchema-LIBRARY Version 2.4\n#\n# R\n#\nDEF R R 0 0 N Y 1 F N\nENDDEF\n';
const EAGLE = '<?xml version="1.0" encoding="utf-8"?>\n<eagle version="9.6.2"><drawing/></eagle>\n';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

// ---------------------------------------------------------------------------------------------
// identity.cjs
// ---------------------------------------------------------------------------------------------
test('identity.cjs: board key (B32) and platform aware path identity (M01)', async (t0) => {
  // Written from the contract text, independent of the implementation.
  const specKey = (files) => {
    const list = files.map(([name, data]) => [name.toLowerCase(), Buffer.from(data)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (list.length === 1) return sha256(list[0][1]);
    const hash = createHash('sha256');
    for (const [name, data] of list) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(data.length));
      hash.update(Buffer.from(name, 'utf8')).update(Buffer.from([0])).update(length).update(data);
    }
    return hash.digest('hex');
  };
  const entry = (name, text) => ({ name, data: new Uint8Array(Buffer.from(text)) });

  await t0.test('one file is the plain SHA-256 of its bytes, so notes saved before companions existed keep working', () => {
    assert.equal(identity.boardKey([entry('Board.CAD', 'abc')]), sha256('abc'));
    assert.equal(identity.boardKey([{ name: 'x.brd', data: Buffer.alloc(0) }]), sha256(''));
  });

  await t0.test('a set is hashed as lowercase name, NUL, uint64 length, bytes in lowercase-name order', () => {
    const files = [['format.asc', 'FMT'], ['pins.asc', 'PINS'], ['nails.asc', 'NAILS']];
    const expected = specKey(files);
    assert.equal(identity.boardKey(files.map(([name, text]) => entry(name, text))), expected);
    assert.match(expected, /^[a-f0-9]{64}$/);
  });

  await t0.test('the key does not depend on the order, the case or the directory prefix of the entries', () => {
    const base = identity.boardKey([entry('format.asc', 'F'), entry('pins.asc', 'P'), entry('nails.asc', 'N')]);
    assert.equal(identity.boardKey([entry('NAILS.ASC', 'N'), entry('Format.Asc', 'F'), entry('pins.asc', 'P')]), base);
    assert.equal(identity.boardKey([entry('C:\\Boards\\pins.asc', 'P'), entry('/x/y/nails.asc', 'N'), entry('format.asc', 'F')]), base);
  });

  await t0.test('any change of any file, a missing file or a renamed file changes the key', () => {
    const base = identity.boardKey([entry('format.asc', 'F'), entry('pins.asc', 'P'), entry('nails.asc', 'N')]);
    for (const changed of [
      [entry('format.asc', 'F2'), entry('pins.asc', 'P'), entry('nails.asc', 'N')],
      [entry('format.asc', 'F'), entry('pins.asc', 'P2'), entry('nails.asc', 'N')],
      [entry('format.asc', 'F'), entry('pins.asc', 'P')],
      [entry('format.asc', 'F'), entry('pins.asc', 'P'), entry('nails2.asc', 'N')],
    ]) assert.notEqual(identity.boardKey(changed), base);
  });

  await t0.test('the length prefix makes the file boundaries unambiguous', () => {
    assert.notEqual(
      identity.boardKey([entry('a.asc', 'xy'), entry('b.asc', 'z')]),
      identity.boardKey([entry('a.asc', 'x'), entry('b.asc', 'yz')]),
    );
  });

  await t0.test('empty, oversized, malformed and duplicate entry lists are rejected', () => {
    for (const bad of [[], undefined, null, 'x', [{}], [{ name: 'a', data: 'text' }], [{ name: 5, data: Buffer.alloc(1) }], [{ name: '', data: Buffer.alloc(1) }], [{ name: 'dir/', data: Buffer.alloc(1) }]]) {
      assert.throws(() => identity.boardKey(bad), { code: 'IDENTITY_INVALID_ENTRIES' }, String(JSON.stringify(bad)));
    }
    assert.throws(() => identity.boardKey(Array.from({ length: 65 }, (_, index) => entry(`f${index}.asc`, 'x'))), { code: 'IDENTITY_INVALID_ENTRIES' });
    assert.throws(() => identity.boardKey([entry('pins.asc', 'a'), entry('PINS.ASC', 'b')]), { code: 'IDENTITY_DUPLICATE_NAME' });
  });

  await t0.test('typed array views with an offset are hashed by their own bytes only', () => {
    const backing = Buffer.from('xxxPINSyyy');
    assert.equal(identity.boardKey([{ name: 'pins.asc', data: backing.subarray(3, 7) }]), sha256('PINS'));
  });

  await t0.test('path identity folds case only where the platform volume does; POSIX paths are never lowercased', () => {
    const upper = '/Boards/U1.cad';
    const lower = '/Boards/u1.cad';
    assert.equal(identity.pathIdentity(upper, { platform: 'win32' }), identity.pathIdentity(lower, { platform: 'win32' }));
    for (const platform of ['linux', 'freebsd']) {
      assert.notEqual(identity.pathIdentity(upper, { platform }), identity.pathIdentity(lower, { platform }));
      assert.equal(identity.pathIdentity(upper, { platform }), upper);
      assert.equal(identity.samePath(upper, lower, { platform }), false);
    }
    // darwin stays exact until a probed volume result says otherwise.
    assert.equal(identity.samePath(upper, lower, { platform: 'darwin' }), false);
    assert.equal(identity.samePath(upper, lower, { platform: 'darwin', caseInsensitive: true }), true);
    assert.equal(identity.samePath(upper, lower, { platform: 'win32', caseInsensitive: false }), false);
    assert.equal(identity.samePath(upper, upper, { platform: 'linux' }), true);
    assert.equal(identity.pathIdentity(upper), identity.pathIdentity(upper, { platform: process.platform }), 'the real platform is the default');
  });

  await t0.test('the case-sensitivity probe recognizes the same inode under a swapped spelling', async () => {
    const stats = (map) => ({ stat: async (filename) => { if (!map.has(filename)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return map.get(filename); } });
    const same = { dev: 1, ino: 77 };
    assert.equal(await identity.probeCaseInsensitive('/Vol/Board.cad', stats(new Map([['/Vol/Board.cad', same], ['/Vol/bOARD.CAD', same]]))), true);
    assert.equal(await identity.probeCaseInsensitive('/Vol/Board.cad', stats(new Map([['/Vol/Board.cad', same]]))), false);
    assert.equal(await identity.probeCaseInsensitive('/Vol/Board.cad', stats(new Map([['/Vol/Board.cad', same], ['/Vol/bOARD.CAD', { dev: 1, ino: 78 }]]))), false, 'a different file under the other spelling means case-sensitive');
    assert.equal(await identity.probeCaseInsensitive('/Vol/Board.cad', stats(new Map())), null, 'the file itself is unreadable: undecided');
    assert.equal(await identity.probeCaseInsensitive('/Vol/123', stats(new Map([['/Vol/123', same]]))), null, 'no letters to swap: undecided');
    const root = await sandbox(t0, 'probe');
    await fs.writeFile(path.join(root, 'Probe.txt'), 'x');
    const real = await identity.probeCaseInsensitive(path.join(root, 'Probe.txt'));
    assert.ok(real === true || real === false, 'the real volume gives a decision');
  });
});

// ---------------------------------------------------------------------------------------------
// workspace.cjs
// ---------------------------------------------------------------------------------------------
const manifestFor = (key, extra = {}) => ({
  version: 1,
  board: { key, name: 'Board.cad', path: '/boards/Board.cad', format: 'gencad' },
  documents: [],
  split: { enabled: false, ratio: 0.5, right: null },
  activeTab: 'board',
  cameras: {},
  updatedAt: NOW,
  ...extra,
});
const documentRecord = (id, extra = {}) => ({
  id, kind: 'pdf', name: `${id}.pdf`, path: `/docs/${id}.pdf`, key: sha256(id), size: 10, bookmarks: [], annotations: [], addedAt: NOW, ...extra,
});

test('workspace.cjs: manifest aliases, board mismatch and notes validation', async (t0) => {
  await t0.test('aliases are optional; valid maps are kept in manifest field order', () => {
    const plain = workspace.validateManifest(manifestFor(KEY), KEY);
    assert.equal('aliases' in plain, false);
    const aliases = { refs: { U1A: 'U1', R5: 'R5' }, nets: { VCC_3V3: '+3V3' } };
    const checked = workspace.validateManifest(manifestFor(KEY, { aliases: { ...aliases, extra: 1 } }), KEY);
    assert.deepEqual(checked.aliases, aliases, 'unknown alias fields are dropped');
    assert.deepEqual(Object.keys(checked), ['version', 'board', 'documents', 'split', 'activeTab', 'cameras', 'aliases', 'updatedAt']);
    assert.deepEqual(workspace.validateManifest(manifestFor(KEY, { aliases: { refs: {}, nets: {} } }), KEY).aliases, { refs: {}, nets: {} });
  });

  await t0.test('aliases reject wrong shapes, non-string values, oversized strings and more than 1000 entries per map', () => {
    const reject = (aliases, label) => assert.throws(() => workspace.validateManifest(manifestFor(KEY, { aliases }), KEY), { code: 'MANIFEST_INVALID' }, label);
    reject(null, 'null');
    reject([], 'array');
    reject('x', 'string');
    reject({ refs: {} }, 'missing nets');
    reject({ nets: {} }, 'missing refs');
    reject({ refs: [], nets: {} }, 'array map');
    reject({ refs: { A: 1 }, nets: {} }, 'number value');
    reject({ refs: { A: null }, nets: {} }, 'null value');
    reject({ refs: {}, nets: { A: { B: 'C' } } }, 'nested object');
    reject({ refs: { ['k'.repeat(257)]: 'v' }, nets: {} }, 'long key');
    reject({ refs: { k: 'v'.repeat(257) }, nets: {} }, 'long value');
    const many = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`R${index}`, `X${index}`]));
    reject({ refs: many(1001), nets: {} }, '1001 refs');
    reject({ refs: {}, nets: many(1001) }, '1001 nets');
    assert.equal(Object.keys(workspace.validateManifest(manifestFor(KEY, { aliases: { refs: many(1000), nets: many(1000) } }), KEY).aliases.refs).length, 1000);
    const edge = { ['k'.repeat(256)]: 'v'.repeat(256) };
    assert.deepEqual(workspace.validateManifest(manifestFor(KEY, { aliases: { refs: edge, nets: {} } }), KEY).aliases.refs, edge);
  });

  await t0.test('a __proto__ key is stored as an ordinary own entry and never changes a prototype', () => {
    const raw = JSON.parse('{"refs":{"__proto__":"U9","R1":"R1"},"nets":{}}');
    const checked = workspace.validateManifest(manifestFor(KEY, { aliases: raw }), KEY);
    assert.equal(Object.getPrototypeOf(checked.aliases.refs), Object.prototype);
    assert.equal(Object.hasOwn(checked.aliases.refs, '__proto__'), true);
    assert.equal(checked.aliases.refs.__proto__, 'U9');
    const camera = JSON.parse('{"__proto__":{"zoom":2}}');
    const cameras = workspace.validateManifest(manifestFor(KEY, { cameras: camera }), KEY).cameras;
    assert.equal(Object.getPrototypeOf(cameras), Object.prototype);
    assert.equal(({}).zoom, undefined);
  });

  await t0.test('W-win-viewers-01: a document camera keeps its fit mode (width, page, none) through the validator; anything else is dropped, not rejected', () => {
    const camera = { page: 2, zoom: 0.585, rotation: 0, x: 12, y: 34 };
    const cameraOf = (value) => workspace.validateManifest(manifestFor(KEY, { cameras: { 'd-pdf': value } }), KEY).cameras['d-pdf'];
    for (const fit of ['width', 'page', 'none']) assert.deepEqual(cameraOf({ ...camera, fit }), { ...camera, fit }, fit);
    assert.deepEqual(Object.keys(cameraOf({ side: 'top', fit: 'page', y: 1, zoom: 2, extra: 1 })), ['zoom', 'y', 'fit', 'side'], 'fixed field order, unknown fields dropped');
    for (const bad of ['fill', 'Width', 'WIDTH', '', 1, 0, null, true, {}, ['width']]) assert.deepEqual(cameraOf({ ...camera, fit: bad }), camera, `dropped: ${JSON.stringify(bad)}`);
    assert.deepEqual(cameraOf({ fit: 'width' }), { fit: 'width' });
    assert.deepEqual(cameraOf({ fit: 'sideways' }), {}, 'nothing but the dropped hint leaves an empty camera');
    const written = workspace.validateManifest(manifestFor(KEY, { cameras: { board: { zoom: 2, side: 'bottom' }, 'd-pdf': { ...camera, fit: 'width' } } }), KEY);
    assert.deepEqual(workspace.validateManifest(JSON.parse(JSON.stringify(written)), KEY), written, 'the workspace file round trip is stable and keeps the fit');
    assert.throws(() => workspace.validateManifest(manifestFor(KEY, { cameras: { 'd-pdf': { fit: 'width', zoom: 0 } } }), KEY), { code: 'MANIFEST_INVALID' }, 'the numbers are still validated next to a valid fit');
  });

  await t0.test('BOARD_MISMATCH: a manifest of another board is never accepted, whatever else it contains', () => {
    const other = 'b'.repeat(64);
    assert.throws(() => workspace.validateManifest(manifestFor(other, { documents: [documentRecord('x')] }), KEY), { code: 'BOARD_MISMATCH' });
    assert.throws(() => workspace.validateManifest(manifestFor(KEY), other), { code: 'BOARD_MISMATCH' });
    assert.throws(() => workspace.validateManifest(manifestFor(KEY), 'not-a-key'), { code: 'INVALID_KEY' });
    assert.throws(() => workspace.manifestName('../x'), { code: 'INVALID_KEY' });
    assert.equal(workspace.manifestName(KEY), `workspaces/${KEY}.json`);
  });

  await t0.test('malformed manifests are rejected with MANIFEST_INVALID and name the field', () => {
    const bad = (mutate, field) => {
      const value = manifestFor(KEY, { documents: [documentRecord('a')] });
      mutate(value);
      assert.throws(() => workspace.validateManifest(value, KEY), (error) => error.code === 'MANIFEST_INVALID' && error.message.includes(field), field);
    };
    bad((value) => { value.version = 2; }, 'version');
    bad((value) => { value.documents[0].key = 'xyz'; }, 'documents[0].key');
    bad((value) => { value.documents.push(documentRecord('a')); }, 'documents[1].id');
    bad((value) => { value.split.right = { kind: 'bogus', id: 'a' }; }, 'split.right.kind');
    bad((value) => { value.activeTab = 'nowhere'; }, 'activeTab');
    bad((value) => { value.updatedAt = 'yesterday'; }, 'updatedAt');
    bad((value) => { value.cameras = []; }, 'cameras');
    for (const garbage of [null, undefined, 5, 'x', []]) assert.throws(() => workspace.validateManifest(garbage, KEY), { code: 'MANIFEST_INVALID' });
  });

  await t0.test('notes: one per target, pin notes and measurements, and old one-per-component notes stay valid', () => {
    const old = [
      { id: 'n1', componentId: 'U1', text: 'check supply', updatedAt: NOW },
      { id: 'n2', componentId: 'U2', text: '', updatedAt: NOW },
    ];
    assert.deepEqual(workspace.validateNotes(old), old, 'notes saved by earlier versions are accepted unchanged');
    const modern = [
      ...old,
      { id: 'n3', componentId: 'U1', pinId: 'U1.3', text: 'pin 3 is low', measurements: { voltage: '0.4 V', resistance: '12 k', other: '' }, updatedAt: NOW },
      { id: 'n4', componentId: 'U1', pinId: 'U1.4', text: '', measurements: {}, updatedAt: NOW },
    ];
    const checked = workspace.validateNotes(modern);
    assert.deepEqual(checked[2].measurements, { voltage: '0.4 V', resistance: '12 k', other: '' });
    assert.equal('measurements' in checked[3], false, 'an empty measurements object is dropped');
    assert.deepEqual(workspace.validateNotes([{ ...old[0], extra: 1 }]), [old[0]], 'unknown fields are dropped');
  });

  await t0.test('B15: a second note for the same component (or the same pin) is rejected on every call', () => {
    const base = { id: 'n1', componentId: 'U1', text: 'a', updatedAt: NOW };
    assert.throws(() => workspace.validateNotes([base, { ...base, id: 'n2' }]), { code: 'NOTES_INVALID', message: /duplicate note for this component/ });
    const pin = { ...base, pinId: 'U1.1' };
    assert.throws(() => workspace.validateNotes([pin, { ...pin, id: 'n2' }]), { code: 'NOTES_INVALID', message: /duplicate note for this pin/ });
    assert.throws(() => workspace.validateNotes([base, { ...base, componentId: 'U2' }]), { code: 'NOTES_INVALID', message: /id \(duplicate\)/ });
    assert.doesNotThrow(() => workspace.validateNotes([base, { ...pin, id: 'n2' }]), 'a component note and one of its pin notes are different targets');
  });

  await t0.test('notes limits: count, text, id, component, pin, measurement and timestamp', () => {
    const base = { id: 'n1', componentId: 'U1', text: 'a', updatedAt: NOW };
    const one = (patch) => workspace.validateNotes([{ ...base, ...patch }]);
    assert.throws(() => workspace.validateNotes(Array.from({ length: 501 }, (_, index) => ({ ...base, id: `n${index}`, componentId: `U${index}` }))), { code: 'TOO_MANY_NOTES' });
    assert.equal(workspace.validateNotes(Array.from({ length: 500 }, (_, index) => ({ ...base, id: `n${index}`, componentId: `U${index}` }))).length, 500);
    for (const patch of [
      { text: 'a'.repeat(8001) }, { id: '' }, { id: 'i'.repeat(129) }, { componentId: '' }, { componentId: 'c'.repeat(257) }, { pinId: '' },
      { pinId: 'p'.repeat(257) }, { updatedAt: 'later' }, { updatedAt: '2'.repeat(41) }, { text: 5 }, { measurements: [] }, { measurements: { voltage: 'v'.repeat(65) } },
      { measurements: { voltage: 5 } },
    ]) assert.throws(() => one(patch), { code: 'NOTES_INVALID' }, JSON.stringify(patch).slice(0, 60));
    for (const garbage of [null, {}, 'x', 5, [null], [5], ['x']]) assert.throws(() => workspace.validateNotes(garbage), (error) => /NOTES_INVALID|TOO_MANY/.test(error.code));
    assert.equal(one({ text: 'a'.repeat(8000) })[0].text.length, 8000);
  });
});

test('workspace.cjs LIMITS stay equal to WORKSPACE_LIMITS of src/lib/documents.ts', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '..', 'src', 'lib', 'documents.ts'), 'utf8');
  const block = /WORKSPACE_LIMITS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
  assert.ok(block, 'WORKSPACE_LIMITS found');
  const declared = Object.fromEntries([...block[1].matchAll(/(\w+):\s*([\d_]+)/g)].map((match) => [match[1], Number(match[2].replace(/_/g, ''))]));
  for (const key of ['documents', 'bookmarks', 'annotations', 'cameras', 'notes', 'aliases', 'text', 'id', 'measurement', 'alias', 'componentId', 'timestamp', 'page']) {
    assert.equal(workspace.LIMITS[key], declared[key], key);
  }
  assert.equal(workspace.LIMITS.path, declared.pathLength, 'pathLength');
});

// ---------------------------------------------------------------------------------------------
// documents.cjs: content sniffing (B34), bounded reads (B33), selection
// ---------------------------------------------------------------------------------------------
test('documents.cjs: content sniffing derives the XML root safely (B34)', async (t0) => {
  const bytes = (text) => Buffer.from(text, 'utf8');
  await t0.test('EAGLE and SVG roots are recognized with or without declaration, comments and DOCTYPE', () => {
    for (const [label, text, expected] of [
      ['declared', '<?xml version="1.0" encoding="utf-8"?>\n<eagle version="9.6.2"></eagle>', 'eagle'],
      ['bare root', '<eagle version="9.6.2"></eagle>', 'eagle'],
      ['comment first', '<!-- exported by a synthetic tool -->\n<eagle version="9.6.2"/>', 'eagle'],
      ['declaration and comment', '<?xml version="1.0"?>\n<!-- c -->\n<eagle/>', 'eagle'],
      ['DOCTYPE with external DTD', '<?xml version="1.0"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9"/>', 'eagle'],
      ['bare DOCTYPE', '<!DOCTYPE eagle SYSTEM "eagle.dtd"><eagle/>', 'eagle'],
      ['DOCTYPE internal subset without entities', '<!DOCTYPE eagle [ <!ELEMENT eagle ANY> ]><eagle/>', 'eagle'],
      ['comment mentioning another root', '<!-- <svg> --><eagle version="9"/>', 'eagle'],
      ['BOM and whitespace', '\uFEFF \r\n\t<eagle/>', 'eagle'],
      ['bare svg', SVG, 'svg'],
      ['svg with declaration and public DOCTYPE', '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>', 'svg'],
      ['svg that contains an eagle element', '<svg><desc><eagle></eagle></desc></svg>', 'svg'],
      ['eagle that contains an svg element', '<eagle><note><svg/></note></eagle>', 'eagle'],
      ['svg after a comment', '<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg'],
      ['svg after a DOCTYPE and a comment', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<!-- c -->\n<svg/>', 'svg'],
      ['svg after a BOM and a comment', '﻿<!-- c --><svg/>', 'svg'],
    ]) assert.equal(documents.sniffContent(bytes(text)), expected, label);
  });

  await t0.test('the prolog scanner is shared with the renderer sniffers: every case of the shared fixture set gets the same verdict here', () => {
    const cases = require('./fixtures/xml-prolog-cases.json');
    assert.ok(cases.length >= 20);
    for (const { label, text, root, bom } of cases) {
      const data = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)]) : bytes(text);
      assert.equal(documents.sniffContent(data), root === 'svg' || root === 'eagle' ? root : null, label);
    }
  });

  await t0.test('anything whose first element is not svg or eagle is not recognized', () => {
    for (const text of ['<html><body/></html>', '<?xml version="1.0"?><note/>', '<?xml version="1.0"?>', '<!doctype html><svg/>', '<!-- only a comment -->', '<?xml version="1.0"', '< eagle/>', '<EAGLE/>', '<SVG/>', 'eagle', '<<eagle/>']) {
      assert.equal(documents.sniffContent(bytes(text)), null, text);
    }
  });

  await t0.test('a DOCTYPE that declares an ENTITY, or cannot be inspected completely, is unsafe and rejected', async () => {
    const root = await sandbox(t0, 'unsafe');
    for (const [label, text] of [
      ['internal entity', '<?xml version="1.0"?>\n<!DOCTYPE eagle [ <!ENTITY x "expanded"> ]>\n<eagle>&x;</eagle>'],
      ['parameter entity', '<!DOCTYPE eagle [ <!ENTITY % p "q"> ]><eagle/>'],
      ['billion laughs shape', '<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY a "x"><!ENTITY b "&a;&a;"> ]><svg>&b;</svg>'],
      ['entity text inside a quoted literal of the subset', '<!DOCTYPE eagle [ <!ELEMENT a ANY> <!ENTITY q "<!ENTITY">]><eagle/>'],
      ['unterminated DOCTYPE', '<!DOCTYPE eagle [ <!ELEMENT a ANY>'],
      ['DOCTYPE larger than the inspection window', `<!DOCTYPE eagle [ ${'<!ELEMENT a ANY> '.repeat(400)}]><eagle/>`],
    ]) {
      assert.equal(documents.sniffContent(bytes(text)), null, label);
      const file = path.join(root, 'unsafe.sch');
      await fs.writeFile(file, text);
      await assert.rejects(documents.readDocument(file), { code: 'DOCUMENT_UNSAFE_XML' }, label);
    }
    const svg = path.join(root, 'unsafe.svg');
    await fs.writeFile(svg, '<!DOCTYPE svg [ <!ENTITY e "x"> ]><svg/>');
    await assert.rejects(documents.readDocument(svg), { code: 'DOCUMENT_UNSAFE_XML' });
  });

  await t0.test('binary signatures, schematic text formats and the PDF header window', () => {
    assert.equal(documents.sniffContent(PDF), 'pdf');
    assert.equal(documents.sniffContent(Buffer.concat([Buffer.from('junk\n'), PDF])), 'pdf', 'the header may follow a few junk bytes');
    assert.equal(documents.sniffContent(Buffer.concat([Buffer.alloc(1100, 0x20), PDF])), null, 'but not beyond the first 1024 bytes');
    assert.equal(documents.sniffContent(PNG), 'png');
    assert.equal(documents.sniffContent(JPEG), 'jpeg');
    assert.equal(documents.sniffContent(WEBP), 'webp');
    assert.equal(documents.sniffContent(bytes(KICAD_SCH)), 'kicad_sch');
    assert.equal(documents.sniffContent(bytes(`\uFEFF  ${KICAD_SCH}`)), 'kicad_sch');
    assert.equal(documents.sniffContent(bytes(LEGACY_SCH)), 'eeschema');
    assert.equal(documents.sniffContent(bytes(LEGACY_LIB)), 'eeschema-lib');
    assert.equal(documents.sniffContent(Buffer.from([0x00, 0x01, 0x02])), null);
    assert.equal(documents.sniffContent(Buffer.from('plain text')), null);
    assert.equal(documents.sniffContent(Buffer.alloc(0)), null);
  });
});

test('documents.cjs: readDocument reads bounded, exact and verified (B33)', async (t0) => {
  const root = await sandbox(t0, 'read');
  const write = async (name, content) => { const filename = path.join(root, name); await fs.writeFile(filename, content); return filename; };
  // A file system whose handle reports the given stat size for one file (the file changed after stat()).
  const lyingFs = (target, size) => new Proxy(fs, { get(source, property) {
    if (property !== 'open') return source[property];
    return async (filename, ...rest) => {
      const handle = await source.open(filename, ...rest);
      if (filename !== target) return handle;
      return new Proxy(handle, { get(file, key) {
        if (key === 'stat') return async () => Object.assign(await file.stat(), { size });
        const value = file[key];
        return typeof value === 'function' ? value.bind(file) : value;
      } });
    };
  } });

  await t0.test('every kind comes back with name, canonical path, sniffed format, hash, size and an exactly sized buffer', async () => {
    for (const [name, content, kind, format] of [
      ['a.pdf', PDF, 'pdf', 'pdf'], ['b.PNG', PNG, 'image', 'png'], ['c.jpg', JPEG, 'image', 'jpeg'], ['d.jpeg', JPEG, 'image', 'jpeg'], ['e.webp', WEBP, 'image', 'webp'],
      ['f.svg', SVG, 'image', 'svg'], ['g.kicad_sch', KICAD_SCH, 'schematic', 'kicad_sch'], ['h.sch', LEGACY_SCH, 'schematic', 'eeschema'], ['i.sch', EAGLE, 'schematic', 'eagle'],
      ['j.sch', KICAD_SCH, 'schematic', 'kicad_sch'], ['k.lib', LEGACY_LIB, 'schematic', 'eeschema-lib'],
    ]) {
      const filename = await write(name, content);
      const document = await documents.readDocument(filename);
      assert.deepEqual([document.name, document.kind, document.format, document.size], [name, kind, format, Buffer.from(content).length], name);
      assert.equal(document.path, await fs.realpath(filename));
      assert.equal(document.key, sha256(content));
      assert.equal(Object.prototype.toString.call(document.data), '[object Uint8Array]');
      assert.equal(document.data.byteLength, document.size);
      assert.equal(document.data.buffer.byteLength, document.size, 'never a pooled or oversized allocation');
      assert.ok(Buffer.from(document.data).equals(Buffer.from(content)));
      assert.equal('companions' in document, false, 'a single read gathers no companions');
    }
  });

  await t0.test('the extension must agree with the content, and the kind filter restricts what is accepted', async () => {
    await assert.rejects(documents.readDocument(await write('fake.png', PDF)), { code: 'DOCUMENT_CONTENT_MISMATCH', message: /PDF/ });
    await assert.rejects(documents.readDocument(await write('fake.pdf', 'plain text')), { code: 'DOCUMENT_CONTENT_MISMATCH', message: /unrecognized/ });
    await assert.rejects(documents.readDocument(await write('fake.svg', EAGLE)), { code: 'DOCUMENT_CONTENT_MISMATCH' });
    await assert.rejects(documents.readDocument(await write('notes.txt', 'x')), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' });
    await assert.rejects(documents.readDocument(await write('noext', PDF)), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' });
    await assert.rejects(documents.readDocument(await write('board.cad', PDF)), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' }, 'a boardview is not a document');
    await assert.rejects(documents.readDocument(path.join(root, 'a.pdf'), { kinds: ['image'] }), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' });
    assert.equal((await documents.readDocument(path.join(root, 'a.pdf'), { kinds: ['pdf', 'image'] })).kind, 'pdf');
    assert.equal((await documents.readDocument(path.join(root, 'a.pdf'), { kinds: 'pdf' })).kind, 'pdf');
    for (const kinds of [[], ['spreadsheet'], 5, ['pdf', 'nope']]) await assert.rejects(documents.readDocument(path.join(root, 'a.pdf'), { kinds }), { code: 'DOCUMENT_INVALID_KIND' }, JSON.stringify(kinds));
    await assert.rejects(documents.readDocument(await write('eagle.svg', EAGLE), { kinds: ['schematic'] }), { code: 'DOCUMENT_UNSUPPORTED_EXTENSION' });
  });

  await t0.test('invalid paths, missing and empty files, directories and size limits fail with stable codes', async () => {
    for (const bad of ['relative.pdf', '../a.pdf', '', 5, undefined, '\\\\server\\share\\a.pdf', '//server/share/a.pdf', `${root}${path.sep}a.pdf\0`]) {
      await assert.rejects(documents.readDocument(bad), { code: 'DOCUMENT_INVALID_PATH' }, String(bad));
    }
    await assert.rejects(documents.readDocument(path.join(root, 'absent.pdf')), { code: 'DOCUMENT_NOT_FOUND' });
    await assert.rejects(documents.readDocument(await write('empty.pdf', '')), { code: 'DOCUMENT_EMPTY' });
    await fs.mkdir(path.join(root, 'folder.pdf'));
    await assert.rejects(documents.readDocument(path.join(root, 'folder.pdf')), { code: 'DOCUMENT_NOT_A_FILE' });
    await assert.rejects(documents.readDocument(path.join(root, 'a.pdf'), { maxBytes: PDF.length - 1 }), { code: 'DOCUMENT_TOO_LARGE' });
    assert.equal((await documents.readDocument(path.join(root, 'a.pdf'), { maxBytes: PDF.length })).size, PDF.length, 'exactly the limit is allowed');
    for (const maxBytes of [0, -1, 1.5, '5']) await assert.rejects(documents.readDocument(path.join(root, 'a.pdf'), { maxBytes }), { code: 'DOCUMENT_INVALID_OPTIONS' });
  });

  await t0.test('B33: a file that shrank after stat() is DOCUMENT_CHANGED, never a truncated payload; growth is caught too', async () => {
    const filename = await write('shrunk.sch', `${LEGACY_SCH}${'#'.repeat(60)}\n`); // 93-byte class fixture
    const real = (await fs.stat(filename)).size;
    // stat() ran when the file was longer: fewer bytes than announced came back.
    await assert.rejects(documents.readDocument(filename, { fs: lyingFs(filename, real + 59) }), { code: 'DOCUMENT_CHANGED' });
    await assert.rejects(documents.readDocument(filename, { fs: lyingFs(filename, real + 1) }), { code: 'DOCUMENT_CHANGED' });
    // stat() ran when the file was shorter: more bytes than announced exist.
    await assert.rejects(documents.readDocument(filename, { fs: lyingFs(filename, real - 1) }), { code: 'DOCUMENT_CHANGED' });
    await assert.rejects(documents.readDocument(filename, { fs: lyingFs(filename, 34) }), { code: 'DOCUMENT_CHANGED' });
    assert.equal((await documents.readDocument(filename, { fs: lyingFs(filename, real) })).size, real, 'an honest stat() reads normally');
  });

  await t0.test('the read budget is acquired for the file size and returned afterwards, also on failure', async () => {
    const budget = createByteBudget(1024 * 1024);
    const seen = [];
    const spy = { acquire: async (bytes, check) => { seen.push([bytes, budget.inFlight]); return budget.acquire(bytes, check); } };
    await documents.readDocument(path.join(root, 'a.pdf'), { budget: spy });
    assert.deepEqual(seen, [[PDF.length, 0]]);
    assert.equal(budget.inFlight, 0);
    await assert.rejects(documents.readDocument(path.join(root, 'fake.png'), { budget: spy }), { code: 'DOCUMENT_CONTENT_MISMATCH' });
    assert.equal(budget.inFlight, 0, 'released although the content check failed');
  });
});

test('documents.cjs: readSelection bounds the count, the bytes and the schematic companions', async (t0) => {
  const root = await sandbox(t0, 'selection');
  const write = async (name, content, directory = root) => { const filename = path.join(directory, name); await fs.writeFile(filename, content); return filename; };
  const countingFs = () => { const state = { opens: 0 }; return { state, fs: new Proxy(fs, { get(target, property) { if (property === 'open') return (...args) => { state.opens++; return target.open(...args); }; return target[property]; } }) }; };

  await t0.test('at most 16 documents per call, refused before any file is opened', async () => {
    const files = [];
    for (let index = 0; index < 17; index++) files.push(await write(`p${index}.pdf`, PDF));
    const counted = countingFs();
    await assert.rejects(documents.readSelection(files, { fs: counted.fs }), { code: 'DOCUMENT_TOO_MANY' });
    assert.equal(counted.state.opens, 0);
    const payloads = await documents.readSelection(files.slice(0, 16));
    assert.equal(payloads.length, 16);
    assert.deepEqual(payloads.map((payload) => payload.name), files.slice(0, 16).map((file) => path.basename(file)), 'selection order is kept');
    assert.deepEqual(await documents.readSelection([]), []);
    await assert.rejects(documents.readSelection('a.pdf'), { code: 'DOCUMENT_INVALID_OPTIONS' });
    assert.equal(documents.MAX_SELECTION_FILES, 16);
    assert.equal(documents.MAX_SELECTION_BYTES, 256 * 1024 * 1024);
  });

  await t0.test('the total byte limit of one call stops the batch with DOCUMENT_BATCH_TOO_LARGE; a single oversized file stays DOCUMENT_TOO_LARGE', async () => {
    const a = await write('big-a.pdf', Buffer.concat([PDF, Buffer.alloc(100, 0x20)]));
    const b = await write('big-b.pdf', Buffer.concat([PDF, Buffer.alloc(100, 0x20)]));
    const size = PDF.length + 100;
    assert.equal((await documents.readSelection([a, b], { maxTotalBytes: size * 2 })).length, 2);
    await assert.rejects(documents.readSelection([a, b], { maxTotalBytes: size * 2 - 1 }), { code: 'DOCUMENT_BATCH_TOO_LARGE' });
    await assert.rejects(documents.readSelection([a, b, a], { maxTotalBytes: size * 2 }), { code: 'DOCUMENT_BATCH_TOO_LARGE' }, 'nothing is left for the third file');
    await assert.rejects(documents.readSelection([a], { maxBytes: size - 1 }), { code: 'DOCUMENT_TOO_LARGE' });
  });

  await t0.test('a schematic carries the schematic files of its own directory as companions; other kinds carry none', async () => {
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const main = await write('Main.kicad_sch', KICAD_SCH, project);
    await write('Sub.KICAD_SCH', KICAD_SCH.replace('synthetic', 'sub'), project);
    await write('legacy.sch', LEGACY_SCH, project);
    await write('parts.lib', LEGACY_LIB, project);
    await write('readme.txt', 'ignored', project);
    await write('drawing.pdf', PDF, project);
    await fs.mkdir(path.join(project, 'folder.sch'));
    const [payload] = await documents.readSelection([main]);
    assert.equal(payload.kind, 'schematic');
    assert.deepEqual(Object.keys(payload.companions).sort(), ['legacy.sch', 'parts.lib', 'sub.kicad_sch'], 'lowercase basenames; the selected file is not its own companion');
    assert.ok(Buffer.from(payload.companions['sub.kicad_sch']).toString().includes('sub'));
    assert.equal(payload.companions['sub.kicad_sch'].buffer.byteLength, payload.companions['sub.kicad_sch'].byteLength);
    assert.deepEqual(payload.skipped, [{ name: 'folder.sch', reason: 'not a file' }]);
    const [pdf] = await documents.readSelection([path.join(project, 'drawing.pdf')]);
    assert.equal('companions' in pdf, false);
    assert.equal('skipped' in pdf, false);
  });

  await t0.test('companions are bounded in count and bytes, share the call budget and never come through a link that leaves the directory', async () => {
    const crowded = path.join(root, 'crowded');
    await fs.mkdir(crowded);
    const main = await write('a-main.kicad_sch', KICAD_SCH, crowded);
    for (let index = 0; index < 40; index++) await write(`s${String(index).padStart(2, '0')}.sch`, LEGACY_SCH, crowded);
    const [payload] = await documents.readSelection([main]);
    assert.equal(Object.keys(payload.companions).length, 32, 'at most 32 companion files');
    assert.ok(payload.skipped.some((item) => item.reason === 'file limit reached'));
    assert.ok(payload.skipped.length <= 65, 'the skipped list is bounded');
    // Bytes: the call budget minus the primary file limits the companions.
    const tight = await readTight(crowded, main);
    assert.ok(Object.keys(tight.companions ?? {}).length < 4);
    assert.ok(tight.skipped.some((item) => item.reason === 'size limit reached' || item.reason === 'selection size limit reached'));
    // Links that leave the directory are not companions (needs permission to create links).
    const linked = path.join(root, 'linked');
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(linked);
    await fs.mkdir(elsewhere);
    const target = await write('outside.sch', LEGACY_SCH, elsewhere);
    const lead = await write('lead.kicad_sch', KICAD_SCH, linked);
    let canLink = true;
    try { await fs.symlink(target, path.join(linked, 'link.sch'), 'file'); } catch { canLink = false; }
    if (canLink) {
      const [result] = await documents.readSelection([lead]);
      assert.equal(result.companions, undefined);
      assert.deepEqual(result.skipped, [{ name: 'link.sch', reason: 'outside the selected directory' }]);
    }
    async function readTight(directory, filename) {
      const size = Buffer.byteLength(KICAD_SCH);
      const [one] = await documents.readSelection([filename], { maxTotalBytes: size + 2 * Buffer.byteLength(LEGACY_SCH) + 1 });
      assert.equal(directory, crowded);
      return one;
    }
  });
});

// ---------------------------------------------------------------------------------------------
// documents.cjs: locating remembered documents
// ---------------------------------------------------------------------------------------------
test('documents.cjs: locateDocuments finds remembered documents by path, then by relative path, and verifies SHA-256', async (t0) => {
  const root = await sandbox(t0, 'locate');
  const boardDir = path.join(root, 'project');
  await fs.mkdir(path.join(boardDir, 'docs'), { recursive: true });
  const boardFile = path.join(boardDir, 'Board.cad');
  await fs.writeFile(boardFile, 'board bytes');
  const write = async (relative, content) => { const filename = path.join(boardDir, ...relative.split('/')); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content); return filename; };
  const request = (id, patch = {}) => ({ id, kind: 'pdf', path: path.join(boardDir, 'docs', 'ref.pdf'), key: sha256(PDF), ...patch });
  const locate = (requests, options) => documents.locateDocuments(boardFile, requests, options);
  const refPdf = await write('docs/ref.pdf', PDF);

  await t0.test('ok: the file is at its absolute path with the remembered bytes (relative path is reported for portability)', async () => {
    const [result] = await locate([request('one')]);
    assert.deepEqual(result, { id: 'one', status: 'ok', path: await fs.realpath(refPdf), relativePath: 'docs/ref.pdf', key: sha256(PDF), size: PDF.length });
  });

  await t0.test('moved: the absolute path is gone but the path relative to the board directory still holds the same bytes', async () => {
    const [result] = await locate([request('two', { path: path.join(root, 'old-home', 'ref.pdf'), relativePath: 'docs/ref.pdf' })]);
    assert.equal(result.status, 'moved');
    assert.equal(result.path, await fs.realpath(refPdf));
    assert.equal(result.relativePath, 'docs/ref.pdf');
    assert.equal(result.key, sha256(PDF));
    const [windowsStyle] = await locate([request('win', { path: path.join(root, 'old-home', 'ref.pdf'), relativePath: 'docs\\ref.pdf' })]);
    assert.equal(windowsStyle.status, 'moved', 'a stored backslash separator is accepted');
  });

  await t0.test('moved also works when the whole project folder was relocated: the board is opened from its new place', async () => {
    const copy = path.join(root, 'relocated');
    await fs.cp(boardDir, copy, { recursive: true });
    const [result] = await documents.locateDocuments(path.join(copy, 'Board.cad'), [request('three', { relativePath: 'docs/ref.pdf' })]);
    assert.equal(result.status, 'ok', 'the old absolute path still exists and still holds the bytes');
    await fs.rm(boardDir, { recursive: true });
    await fs.cp(copy, boardDir, { recursive: true });
    const [moved] = await documents.locateDocuments(path.join(copy, 'Board.cad'), [request('four', { relativePath: 'docs/ref.pdf', path: path.join(root, 'gone', 'ref.pdf') })]);
    assert.equal(moved.status, 'moved');
    assert.equal(moved.path, await fs.realpath(path.join(copy, 'docs', 'ref.pdf')));
  });

  await t0.test('changed: a file exists but its bytes differ; its actual hash is reported, and an exact match elsewhere wins', async () => {
    const edited = await write('docs/edited.pdf', Buffer.concat([PDF, Buffer.from('% edited\n')]));
    const [result] = await locate([request('five', { path: edited })]);
    assert.equal(result.status, 'changed');
    assert.equal(result.key, sha256(Buffer.concat([PDF, Buffer.from('% edited\n')])));
    assert.equal(result.size, PDF.length + 9);
    assert.equal(result.path, await fs.realpath(edited));
    assert.match(result.message, /differs/);
    const [better] = await locate([request('six', { path: edited, relativePath: 'docs/ref.pdf' })]);
    assert.equal(better.status, 'moved', 'the relative candidate has the remembered bytes');
    assert.equal(better.path, await fs.realpath(refPdf));
  });

  await t0.test('missing and unreadable', async () => {
    assert.deepEqual((await locate([request('seven', { path: path.join(boardDir, 'nowhere.pdf'), relativePath: 'docs/nowhere.pdf' })]))[0], { id: 'seven', status: 'missing' });
    assert.deepEqual((await locate([request('eight', { path: 'not-absolute.pdf' })]))[0], { id: 'eight', status: 'missing' });
    await fs.mkdir(path.join(boardDir, 'docs', 'folder.pdf'));
    const [directory] = await locate([request('nine', { path: path.join(boardDir, 'docs', 'folder.pdf') })]);
    assert.equal(directory.status, 'unreadable');
    const [wrongKind] = await locate([request('ten', { kind: 'image' })]);
    assert.equal(wrongKind.status, 'unreadable', 'a PDF is not an image document');
    assert.match(wrongKind.message, /image/);
    const huge = await write('docs/huge.pdf', '');
    await fs.truncate(huge, 64 * 1024 * 1024 + 1);
    const [oversized] = await locate([request('eleven', { path: huge })]);
    assert.equal(oversized.status, 'unreadable');
  });

  await t0.test('relative paths cannot traverse, be absolute or leave the board directory tree', async () => {
    await fs.writeFile(path.join(root, 'secret.pdf'), PDF);
    for (const relativePath of ['../secret.pdf', 'docs/../../secret.pdf', '/etc/passwd', '\\windows\\system.ini', 'C:\\secret.pdf', 'docs/./ref.pdf', 'docs//ref.pdf', 'docs/ref.pdf/', '', 'docs/re\0f.pdf', 'docs/ref.pdf:stream']) {
      const [result] = await locate([request('trav', { path: path.join(root, 'absent.pdf'), relativePath })]);
      assert.ok(['unreadable', 'missing'].includes(result.status), `${JSON.stringify(relativePath)} -> ${result.status}`);
      assert.equal(result.path, undefined, `${JSON.stringify(relativePath)} was not followed`);
    }
    // A link inside the tree whose target lies outside it is not followed either.
    let canLink = true;
    try { await fs.symlink(path.join(root, 'secret.pdf'), path.join(boardDir, 'docs', 'escape.pdf'), 'file'); } catch { canLink = false; }
    if (canLink) {
      const [result] = await locate([request('link', { path: path.join(root, 'absent.pdf'), relativePath: 'docs/escape.pdf', key: sha256(PDF) })]);
      assert.equal(result.status, 'unreadable');
      assert.match(result.message, /leaves the board directory/);
      assert.equal(result.path, undefined);
    }
  });

  await t0.test('relativePath is only reported for files inside the board tree', async () => {
    const outside = path.join(root, 'outside-ref.pdf');
    await fs.writeFile(outside, PDF);
    const [result] = await locate([request('out', { path: outside })]);
    assert.equal(result.status, 'ok');
    assert.equal('relativePath' in result, false);
  });

  await t0.test('the board path is validated; results keep the request order', async () => {
    for (const bad of ['relative/Board.cad', '', 5, undefined, '\\\\server\\share\\Board.cad', path.join(boardDir, 'Board.txt'), `${boardFile}\0`]) {
      await assert.rejects(documents.locateDocuments(bad, [request('x')]), (error) => /^DOCUMENT_INVALID_PATH$/.test(error.code), String(bad));
    }
    const results = await locate([request('b', { path: path.join(boardDir, 'nowhere.pdf') }), request('a'), request('c', { key: sha256('other') })]);
    assert.deepEqual(results.map((result) => [result.id, result.status]), [['b', 'missing'], ['a', 'ok'], ['c', 'changed']]);
    assert.deepEqual(await locate([]), []);
    // The board directory may be gone: absolute candidates still work.
    const [onlyAbsolute] = await documents.locateDocuments(path.join(root, 'vanished', 'Board.cad'), [request('abs', { relativePath: 'docs/ref.pdf' })]);
    assert.equal(onlyAbsolute.status, 'ok');
    assert.equal('relativePath' in onlyAbsolute, false);
  });

  await t0.test('malformed requests are rejected as a whole', async () => {
    for (const bad of [
      [{ id: '', kind: 'pdf', path: '/x', key: KEY }], [{ id: 'a', kind: 'video', path: '/x', key: KEY }], [{ id: 'a', kind: 'pdf', path: 5, key: KEY }],
      [{ id: 'a', kind: 'pdf', path: '/x', key: 'short' }], [{ id: 'a', kind: 'pdf', path: '/x', key: KEY, relativePath: 7 }], [null], ['x'], 'x', {},
      Array.from({ length: 201 }, (_, index) => request(`r${index}`)),
    ]) await assert.rejects(locate(bad), { code: 'DOCUMENT_INVALID_REQUEST' }, JSON.stringify(bad).slice(0, 80));
  });

  await t0.test('concurrency is bounded', async () => {
    let active = 0;
    let peak = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowFs = new Proxy(fs, { get(target, property) {
      if (property !== 'open') return target[property];
      return async (filename, ...rest) => {
        const handle = await target.open(filename, ...rest);
        if (!filename.endsWith('.pdf')) return handle;
        active++; peak = Math.max(peak, active);
        await gate;
        return new Proxy(handle, { get(file, key) {
          if (key === 'close') return async () => { active--; return file.close(); };
          const value = file[key];
          return typeof value === 'function' ? value.bind(file) : value;
        } });
      };
    } });
    const requests = Array.from({ length: 12 }, (_, index) => request(`c${index}`));
    const running = locate(requests, { fs: slowFs });
    await settle(() => active >= 4);
    await sleep(40);
    assert.equal(active, 4, 'only four documents are hashed at a time');
    release();
    const results = await running;
    assert.equal(peak, 4);
    assert.ok(results.every((result) => result.status === 'ok'));
    await assert.rejects(locate([request('z')], { concurrency: 0 }), { code: 'DOCUMENT_INVALID_OPTIONS' });
  });

  await t0.test('hashing never holds the whole file: a 20 MiB document is read in chunks, and a file that changes while hashing is reported', async () => {
    const big = path.join(boardDir, 'docs', 'big.pdf');
    await fs.writeFile(big, PDF);
    await fs.truncate(big, 20 * 1024 * 1024);
    const sizes = [];
    const watching = new Proxy(fs, { get(target, property) {
      if (property !== 'open') return target[property];
      return async (filename, ...rest) => {
        const handle = await target.open(filename, ...rest);
        if (filename !== big) return handle;
        return new Proxy(handle, { get(file, key) {
          if (key === 'read') return (buffer, ...args) => { sizes.push(buffer.byteLength); return file.read(buffer, ...args); };
          const value = file[key];
          return typeof value === 'function' ? value.bind(file) : value;
        } });
      };
    } });
    const hash = await documents.hashFile(big, { fs: watching });
    assert.equal(hash.size, 20 * 1024 * 1024);
    assert.ok(Math.max(...sizes) <= 1024 * 1024 + 0, 'no buffer larger than one chunk');
    assert.equal(hash.key, sha256(Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024 - PDF.length)])));
    const lying = new Proxy(fs, { get(target, property) {
      if (property !== 'open') return target[property];
      return async (filename, ...rest) => {
        const handle = await target.open(filename, ...rest);
        if (filename !== big) return handle;
        return new Proxy(handle, { get(file, key) {
          if (key === 'stat') return async () => Object.assign(await file.stat(), { size: 20 * 1024 * 1024 + 7 });
          const value = file[key];
          return typeof value === 'function' ? value.bind(file) : value;
        } });
      };
    } });
    await assert.rejects(documents.hashFile(big, { fs: lying }), { code: 'DOCUMENT_CHANGED' });
    const [reported] = await locate([request('big', { path: big, key: hash.key })], { fs: lying });
    assert.equal(reported.status, 'unreadable');
  });
});

// ---------------------------------------------------------------------------------------------
// documents.cjs: workspace export bundle
// ---------------------------------------------------------------------------------------------
test('documents.cjs: exportBundle writes ONLY the requested files, with safe names and relative paths, atomically', async (t0) => {
  const root = await sandbox(t0, 'export');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  const BOARD = Buffer.from('$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 10 0\n$ENDBOARD\n');
  const boardFile = path.join(project, 'Board.cad');
  await fs.writeFile(boardFile, BOARD);
  const files = {
    pdf: { name: 'datasheet.pdf', kind: 'pdf', content: PDF },
    png: { name: 'photo.png', kind: 'image', content: PNG },
    sch: { name: 'power.kicad_sch', kind: 'schematic', content: Buffer.from(KICAD_SCH) },
    unselected: { name: 'private-notes.pdf', kind: 'pdf', content: Buffer.concat([PDF, Buffer.from('% private\n')]) },
  };
  for (const file of Object.values(files)) await fs.writeFile(path.join(project, 'docs', file.name), file.content);
  const record = (id, file, extra = {}) => ({
    id, kind: file.kind, name: file.name, path: path.join(project, 'docs', file.name), relativePath: `docs/${file.name}`, key: sha256(file.content), size: file.content.length,
    bookmarks: [{ id: 'bm', page: 1, label: 'power' }], annotations: [], addedAt: NOW, ...extra,
  });
  const manifest = {
    version: 1, board: { key: KEY, name: 'Board.cad', path: boardFile, format: 'gencad' },
    documents: [record('d-pdf', files.pdf, { missing: true }), record('d-png', files.png), record('d-sch', files.sch), record('d-private', files.unselected)],
    split: { enabled: true, ratio: 0.4, right: { kind: 'document', id: 'd-private' } }, activeTab: 'documents',
    cameras: { board: { zoom: 2 }, 'd-pdf': { page: 3 }, 'd-private': { page: 9 } },
    aliases: { refs: { U1A: 'U1' }, nets: { '+3V3': 'VDD' } }, updatedAt: NOW,
  };
  const boardFiles = [{ name: 'Board.cad', path: boardFile, primary: true, data: new Uint8Array(BOARD) }];
  const unzip = async (target) => fflate.unzipSync(new Uint8Array(await fs.readFile(target)));
  const text = (bytes) => Buffer.from(bytes).toString('utf8');
  const originals = async () => Object.fromEntries(await Promise.all([['board', boardFile], ...Object.entries(files).map(([id, file]) => [id, path.join(project, 'docs', file.name)])].map(async ([id, filename]) => [id, sha256(await fs.readFile(filename))])));
  const before = await originals();
  const leftovers = async (directory) => (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'));
  let counter = 0;
  const target = () => path.join(root, `bundle-${++counter}.zip`);

  await t0.test('only the selected documents, the board when asked, the notes when given; paths in the bundled manifest are relative', async () => {
    const out = target();
    const notes = [{ id: 'n1', componentId: 'U1', text: 'check 3V3', updatedAt: NOW }];
    const result = await documents.exportBundle({ manifest, notes, documentIds: ['d-pdf', 'd-sch'], includeBoard: true, boardFiles, target: out });
    const entries = await unzip(out);
    assert.deepEqual(Object.keys(entries).sort(), ['board/Board.cad', 'documents/datasheet.pdf', 'documents/power.kicad_sch', 'notes.json', 'workspace.json']);
    assert.deepEqual(result, { path: out, files: 5, bytes: (await fs.stat(out)).size });
    assert.ok(Buffer.from(entries['documents/datasheet.pdf']).equals(files.pdf.content));
    assert.ok(Buffer.from(entries['documents/power.kicad_sch']).equals(files.sch.content));
    assert.ok(Buffer.from(entries['board/Board.cad']).equals(BOARD));
    assert.deepEqual(JSON.parse(text(entries['notes.json'])), notes);
    const bundled = JSON.parse(text(entries['workspace.json']));
    assert.deepEqual(bundled.documents.map((document) => [document.id, document.path, document.relativePath]), [['d-pdf', 'documents/datasheet.pdf', 'documents/datasheet.pdf'], ['d-sch', 'documents/power.kicad_sch', 'documents/power.kicad_sch']]);
    assert.equal('missing' in bundled.documents[0], false);
    assert.equal(bundled.board.path, 'board/Board.cad');
    assert.equal(bundled.board.key, KEY);
    assert.deepEqual(bundled.cameras, { board: { zoom: 2 }, 'd-pdf': { page: 3 } }, 'cameras of documents that are not exported are dropped');
    assert.deepEqual(bundled.split, { enabled: false, ratio: 0.4, right: null }, 'a split on an unselected document is switched off');
    assert.deepEqual(bundled.aliases, manifest.aliases);
    assert.equal(JSON.stringify(bundled).includes(root), false, 'no absolute local path leaves the machine');
    assert.equal(JSON.stringify(bundled).includes('private'), false, 'nothing of the unselected document');
    assert.doesNotThrow(() => workspace.validateManifest(bundled, KEY), 'the bundled manifest is itself a valid manifest');
    assert.deepEqual(await originals(), before, 'originals are never modified');
    assert.deepEqual(await leftovers(root), []);
  });

  await t0.test('W-win-viewers-01: the camera fit survives validation (as main.cjs applies it before exporting), the bundle and a re-validation of the bundled manifest', async () => {
    const fitted = { ...manifest, cameras: { board: { zoom: 2 }, 'd-pdf': { page: 3, zoom: 0.585, rotation: 0, x: 1, y: 2, fit: 'width' }, 'd-png': { zoom: 1.5, fit: 'none' }, 'd-private': { page: 9, fit: 'page' } } };
    const checked = workspace.validateManifest(fitted, KEY);
    assert.equal(checked.cameras['d-pdf'].fit, 'width');
    const out = target();
    await documents.exportBundle({ manifest: checked, documentIds: ['d-pdf', 'd-png'], includeBoard: false, target: out });
    const bundled = JSON.parse(text((await unzip(out))['workspace.json']));
    assert.deepEqual(bundled.cameras, { board: { zoom: 2 }, 'd-pdf': { page: 3, zoom: 0.585, rotation: 0, x: 1, y: 2, fit: 'width' }, 'd-png': { zoom: 1.5, fit: 'none' } });
    assert.deepEqual(workspace.validateManifest(bundled, KEY).cameras, bundled.cameras);
  });

  await t0.test('without the board and notes the bundle holds just the manifest and the documents', async () => {
    const out = target();
    await documents.exportBundle({ manifest, documentIds: ['d-png'], includeBoard: false, target: out });
    const entries = await unzip(out);
    assert.deepEqual(Object.keys(entries).sort(), ['documents/photo.png', 'workspace.json']);
    const bundled = JSON.parse(text(entries['workspace.json']));
    assert.equal(bundled.board.path, 'Board.cad', 'the board is not bundled: only its name remains');
    await documents.exportBundle({ manifest, documentIds: [], includeBoard: false, target: out });
    assert.deepEqual(Object.keys(await unzip(out)), ['workspace.json'], 'an empty selection bundles nothing else');
    await documents.exportBundle({ manifest, notes: [], documentIds: [], includeBoard: false, target: out });
    assert.deepEqual(Object.keys(await unzip(out)).sort(), ['notes.json', 'workspace.json']);
  });

  await t0.test('a companion board (ASC trio) is bundled as a whole set under board/', async () => {
    const out = target();
    const trio = [
      { name: 'format.asc', path: path.join(project, 'format.asc'), primary: true, data: new Uint8Array(Buffer.from('F')) },
      { name: 'pins.asc', path: path.join(project, 'pins.asc'), data: new Uint8Array(Buffer.from('P')) },
      { name: 'nails.asc', path: path.join(project, 'nails.asc'), data: new Uint8Array(Buffer.from('N')) },
    ];
    await documents.exportBundle({ manifest, documentIds: [], includeBoard: true, boardFiles: trio, target: out });
    const entries = await unzip(out);
    assert.deepEqual(Object.keys(entries).sort(), ['board/format.asc', 'board/nails.asc', 'board/pins.asc', 'workspace.json']);
    assert.equal(JSON.parse(text(entries['workspace.json'])).board.path, 'board/format.asc', 'the primary file leads');
  });

  // Two names that differ only by case must never share a directory in a fixture (I05): on a case-insensitive volume (Windows,
  // default macOS) the second write replaces the first, its recorded hash goes stale and the export correctly refuses it.
  // `foldingWrite` emulates such a volume on any host, so the suite proves the fixtures independent of the volume it runs on.
  const foldingWrite = async (filename, content) => {
    const existing = (await fs.readdir(path.dirname(filename))).find((name) => name.toLowerCase() === path.basename(filename).toLowerCase());
    await fs.writeFile(existing ? path.join(path.dirname(filename), existing) : filename, content);
  };
  const volumes = { 'the volume of this host': (filename, content) => fs.writeFile(filename, content), 'an emulated case-insensitive volume': foldingWrite };
  const writeNasty = async (directory, write, caseTwins) => {
    const names = ['..hidden.pdf', 'a\\b.pdf', 'con.pdf', ' spaced name .pdf', 'q?*<>|".pdf', '....pdf', `${'x'.repeat(200)}.pdf`, 'UPPER.PDF', 'upper.pdf'];
    const records = [];
    const written = [];
    for (const [index, name] of names.entries()) {
      const filename = path.join(name === 'upper.pdf' ? caseTwins : directory, name);
      const content = Buffer.concat([PDF, Buffer.from(`% ${index}\n`)]);
      try { await write(filename, content); } catch { continue; }
      written.push({ filename, content });
      records.push({ id: `n${index}`, kind: 'pdf', name: '../../evil.pdf', path: filename, key: sha256(content), size: content.length, bookmarks: [], annotations: [], addedAt: NOW });
    }
    return { records, written };
  };
  const bundleOf = (records, out) => documents.exportBundle({ manifest: { ...manifest, documents: records, split: { enabled: false, ratio: 0.5, right: null } }, documentIds: records.map((item) => item.id), includeBoard: false, target: out });

  for (const [index, [volume, write]] of Object.entries(volumes).entries()) {
    await t0.test(`entry names are zip-slip safe whatever the original file names are (${volume}; I05: case twins live in separate directories)`, async () => {
      const nasty = path.join(root, `nasty-${index}`);
      const lowerDirectory = path.join(root, `nasty-lower-${index}`);
      await fs.mkdir(nasty);
      await fs.mkdir(lowerDirectory);
      const { records, written } = await writeNasty(nasty, write, lowerDirectory);
      // No directory holds two names equal modulo case, so nothing could have replaced another file, and every original
      // still has exactly the bytes its recorded hash describes.
      for (const directory of [nasty, lowerDirectory]) {
        const present = (await fs.readdir(directory)).map((name) => name.toLowerCase());
        assert.equal(new Set(present).size, present.length, `${path.basename(directory)} holds no two names that differ only by case`);
      }
      for (const { filename, content } of written) assert.ok((await fs.readFile(filename)).equals(content), `${path.basename(filename)} still has the bytes that were written`);
      assert.ok(['UPPER.PDF', 'upper.pdf'].every((name) => records.some((item) => path.basename(item.path) === name)), 'both case twins are part of the export');
      const out = target();
      await bundleOf(records, out);
      const archive = await unzip(out);
      const entries = Object.keys(archive);
      assert.equal(entries.length, records.length + 1);
      const lowered = entries.map((name) => name.toLowerCase());
      assert.equal(new Set(lowered).size, lowered.length, 'names stay unique even where the extractor ignores case');
      assert.ok(entries.includes('documents/UPPER.PDF') && entries.includes('documents/upper (2).pdf'), 'the two names that differ only by case get distinct bundle entries');
      assert.ok(Buffer.from(archive['documents/UPPER.PDF']).equals(written.find((item) => path.basename(item.filename) === 'UPPER.PDF').content), 'each twin keeps its own bytes');
      assert.ok(Buffer.from(archive['documents/upper (2).pdf']).equals(written.find((item) => path.basename(item.filename) === 'upper.pdf').content));
      for (const name of entries) {
        assert.ok(name === 'workspace.json' || /^documents\/[^/\\]+$/.test(name), name);
        assert.equal(name.split('/').some((segment) => segment === '..' || segment === '.' || segment === ''), false, name);
        assert.equal(/[\\:*?"<>|\0]/.test(name), false, name);
        assert.ok(name.length < 140);
      }
      assert.equal(entries.some((name) => /^documents\/(con|\.)/i.test(name)), false, 'no device name and no hidden dot file');
      assert.equal(documents.safeFileName('../../etc/passwd'), '.._.._etc_passwd'.replace(/^[.]+/, ''));
      assert.equal(documents.safeFileName('CON'), '_CON');
      assert.equal(documents.safeFileName('..'), 'file');
      assert.equal(documents.safeFileName(''), 'file');
    });
  }

  await t0.test('I05 control: with both case twins in ONE directory of a case-insensitive volume the first original is replaced and the export refuses it (the content-change safeguard stays)', async () => {
    const shared = path.join(root, 'nasty-shared');
    await fs.mkdir(shared);
    const { records } = await writeNasty(shared, foldingWrite, shared);
    const refused = target();
    await assert.rejects(bundleOf(records, refused), { code: 'EXPORT_DOCUMENT_UNAVAILABLE', message: /changed/ });
    await assert.rejects(fs.stat(refused), { code: 'ENOENT' }, 'nothing was created');
  });

  await t0.test('colliding file names get distinct entries', async () => {
    const other = path.join(project, 'docs2');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'datasheet.pdf'), files.unselected.content);
    const twin = { ...record('d-twin', files.unselected), name: 'datasheet.pdf', path: path.join(other, 'datasheet.pdf'), relativePath: 'docs2/datasheet.pdf' };
    const out = target();
    await documents.exportBundle({ manifest: { ...manifest, documents: [...manifest.documents, twin] }, documentIds: ['d-pdf', 'd-twin'], includeBoard: false, target: out });
    const entries = await unzip(out);
    assert.deepEqual(Object.keys(entries).sort(), ['documents/datasheet (2).pdf', 'documents/datasheet.pdf', 'workspace.json']);
    assert.ok(Buffer.from(entries['documents/datasheet (2).pdf']).equals(files.unselected.content));
  });

  await t0.test('a document that was moved is found through its relative path; a changed or missing one aborts the export before anything is written', async () => {
    const relocated = { ...manifest, documents: [record('d-moved', files.pdf, { path: path.join(root, 'old-place', 'datasheet.pdf') })] };
    const out = target();
    await documents.exportBundle({ manifest: relocated, documentIds: ['d-moved'], includeBoard: false, target: out });
    assert.ok(Buffer.from((await unzip(out))['documents/datasheet.pdf']).equals(files.pdf.content));
    const changed = { ...manifest, documents: [record('d-changed', files.pdf, { key: sha256('other bytes') })] };
    const missing = { ...manifest, documents: [record('d-missing', files.pdf, { path: path.join(root, 'void', 'x.pdf'), relativePath: 'docs/void.pdf' })] };
    for (const [bad, id, status] of [[changed, 'd-changed', 'changed'], [missing, 'd-missing', 'missing']]) {
      const refused = target();
      await assert.rejects(documents.exportBundle({ manifest: bad, documentIds: [id], includeBoard: false, target: refused }), { code: 'EXPORT_DOCUMENT_UNAVAILABLE', message: new RegExp(status) });
      await assert.rejects(fs.stat(refused), { code: 'ENOENT' });
    }
    assert.deepEqual(await leftovers(root), []);
  });

  await t0.test('the request is validated: unknown, duplicate and malformed ids, missing board files, limits', async () => {
    const run = (patch) => documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: target(), ...patch });
    await assert.rejects(run({ documentIds: ['nope'] }), { code: 'EXPORT_UNKNOWN_DOCUMENT' });
    await assert.rejects(run({ documentIds: ['d-pdf', 'd-pdf'] }), { code: 'EXPORT_INVALID_REQUEST' });
    await assert.rejects(run({ documentIds: 'd-pdf' }), { code: 'EXPORT_INVALID_REQUEST' });
    await assert.rejects(run({ documentIds: [5] }), { code: 'EXPORT_UNKNOWN_DOCUMENT' });
    await assert.rejects(run({ includeBoard: true }), { code: 'EXPORT_INVALID_REQUEST' });
    await assert.rejects(run({ includeBoard: true, boardFiles: [] }), { code: 'EXPORT_INVALID_REQUEST' });
    await assert.rejects(run({ target: 'relative.zip' }), { code: 'DOCUMENT_INVALID_PATH' });
    await assert.rejects(run({ maxTotalBytes: 100 }), { code: 'EXPORT_TOO_LARGE' });
    assert.equal(typeof (await run({ maxTotalBytes: 100000 })).bytes, 'number');
  });

  await t0.test('the bundle may never replace one of the files it was built from', async () => {
    for (const source of [boardFile, path.join(project, 'docs', files.pdf.name), path.join(project, 'docs', files.png.name)]) {
      const original = await fs.readFile(source);
      await assert.rejects(
        documents.exportBundle({ manifest, documentIds: ['d-pdf', 'd-png'], includeBoard: true, boardFiles, target: source }),
        { code: 'EXPORT_OVERWRITES_SOURCE' }, path.basename(source),
      );
      assert.ok((await fs.readFile(source)).equals(original));
    }
    let canLink = true;
    const link = path.join(root, 'alias.zip');
    try { await fs.symlink(path.join(project, 'docs', files.pdf.name), link, 'file'); } catch { canLink = false; }
    if (canLink) await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: link }), { code: 'EXPORT_OVERWRITES_SOURCE' }, 'a link to a source is the source');
    const hard = path.join(root, 'hard.zip');
    try { await fs.link(path.join(project, 'docs', files.pdf.name), hard); await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: hard }), { code: 'EXPORT_OVERWRITES_SOURCE' }, 'a hard link to a source is the source'); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    assert.deepEqual(await originals(), before);
  });

  await t0.test('a failed write leaves neither a partial file nor a temporary one; an existing target stays intact until the rename', async () => {
    const out = target();
    await fs.writeFile(out, 'previous export');
    let renames = 0;
    const failing = new Proxy(fs, { get(source, property) {
      if (property === 'rename') return async () => { renames++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
      return source[property];
    } });
    await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: out, fs: failing }), { code: 'EXPORT_WRITE_FAILED' });
    assert.equal(renames, 1);
    assert.equal(await fs.readFile(out, 'utf8'), 'previous export', 'atomic: the old file is untouched');
    assert.deepEqual(await leftovers(root), []);
    await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: path.join(root, 'no-such-dir', 'x.zip') }), { code: 'EXPORT_WRITE_FAILED' });
    await documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: out });
    assert.ok((await unzip(out))['workspace.json'], 'a later export replaces it');
  });

  // A FileHandle facade for the temporary zip only: `behave(real, call, buffer, offset, length, position)` decides what one write()
  // does, `events` records the order of write/sync/close/rename. The real handle behind it receives whatever the facade delegates.
  const facadeFs = (behave) => {
    const events = [];
    const facade = new Proxy(fs, { get(source, property) {
      if (property === 'rename') return async (from, to) => { events.push('rename'); return source.rename(from, to); };
      if (property !== 'open') return source[property];
      return async (filename, ...rest) => {
        const real = await source.open(filename, ...rest);
        if (!filename.endsWith('.tmp')) return real;
        let call = 0;
        return {
          async write(buffer, offset = 0, length = buffer.byteLength - offset, position = null) { events.push('write'); return behave(real, ++call, buffer, offset, length, position); },
          async sync() { events.push('sync'); return real.sync(); },
          async close() { events.push('close'); return real.close(); },
        };
      };
    } });
    return { fs: facade, events };
  };
  const shortWrites = (limit) => (real, _call, buffer, offset, length, position) => real.write(buffer, offset, Math.min(limit, length), position);

  await t0.test('B45: a legal short write never truncates the bundle: every chunk is written completely and only the bytes actually written are reported', async () => {
    const request = { manifest, documentIds: ['d-png'], includeBoard: false };
    // Control: normal writes produce a standard archive with only the ticked PNG and the manifest.
    const control = target();
    const normal = await documents.exportBundle({ ...request, target: control });
    const controlEntries = await unzip(control);
    assert.deepEqual(Object.keys(controlEntries).sort(), ['documents/photo.png', 'workspace.json']);
    assert.equal(normal.bytes, (await fs.stat(control)).size);
    const controlManifest = text(controlEntries['workspace.json']);
    for (const forbidden of ['private', 'datasheet', 'notes', root]) assert.equal(controlManifest.includes(forbidden), false, `no ${forbidden} in the control bundle`);
    // The same export through a handle that accepts at most 7 bytes per write().
    const shorted = facadeFs(shortWrites(7));
    const out = target();
    const result = await documents.exportBundle({ ...request, target: out, fs: shorted.fs });
    const size = (await fs.stat(out)).size;
    assert.equal(result.bytes, size, 'the reported bytes are the bytes on disk');
    assert.equal(size, normal.bytes, 'the archive is complete');
    assert.ok(shorted.events.filter((event) => event === 'write').length >= Math.ceil(size / 7), 'the facade really delivered the bytes in pieces of at most 7');
    const entries = await unzip(out);
    assert.deepEqual(Object.keys(entries).sort(), ['documents/photo.png', 'workspace.json']);
    assert.ok(Buffer.from(entries['documents/photo.png']).equals(files.png.content));
    assert.deepEqual(JSON.parse(text(entries['workspace.json'])), JSON.parse(controlManifest));
    assert.deepEqual(shorted.events.filter((event) => event !== 'write'), ['close', 'rename'], 'the handle is closed, then the file is renamed into place');
    assert.deepEqual(await leftovers(root), []);
  });

  await t0.test('B45: a zero-byte write, an impossible byte count or a write error after partial progress fails the export atomically (EXPORT_WRITE_FAILED)', async () => {
    const partialThen = (second) => (real, call, buffer, offset, length, position) => (call === 1 ? real.write(buffer, offset, Math.min(7, length), position) : second(real, call, buffer, offset, length, position));
    const cases = {
      'every write returns 0 bytes': async () => ({ bytesWritten: 0 }),
      'a write returns 0 bytes after partial progress': partialThen(async () => ({ bytesWritten: 0 })),
      'a write throws after partial progress': partialThen(async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); }),
      'a write reports a negative count': partialThen(async () => ({ bytesWritten: -1 })),
      'a write reports NaN': partialThen(async () => ({ bytesWritten: Number.NaN })),
      'a write reports more than it was given': partialThen(async (_real, _call, _buffer, _offset, length) => ({ bytesWritten: length + 1 })),
    };
    for (const [label, behave] of Object.entries(cases)) {
      const out = target();
      await fs.writeFile(out, 'previous export');
      const broken = facadeFs(behave);
      await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-png'], includeBoard: false, target: out, fs: broken.fs }), { code: 'EXPORT_WRITE_FAILED' }, label);
      assert.equal(broken.events.includes('rename'), false, `${label}: nothing was renamed into place`);
      assert.equal(broken.events.includes('close'), true, `${label}: the handle was closed`);
      assert.equal(await fs.readFile(out, 'utf8'), 'previous export', `${label}: the existing target is untouched`);
      assert.deepEqual(await leftovers(root), [], `${label}: the temporary file is gone`);
    }
  });

  await t0.test('a document whose bytes change while the bundle is built is refused, not bundled', async () => {
    const out = target();
    let swapped = false;
    let opens = 0;
    const racing = new Proxy(fs, { get(source, property) {
      if (property !== 'open') return source[property];
      return async (filename, ...rest) => {
        const handle = await source.open(filename, ...rest);
        // After the verifying hash pass, the second (content) read sees different bytes.
        if (filename.endsWith('datasheet.pdf') && !swapped && (rest[0] === 'r')) {
          opens++;
          if (opens === 2) {
            swapped = true;
            await handle.close();
            const replaced = Buffer.concat([PDF, Buffer.from('% changed\n')]);
            await fs.writeFile(filename, replaced);
            return source.open(filename, ...rest);
          }
        }
        return handle;
      };
    } });
    await assert.rejects(documents.exportBundle({ manifest, documentIds: ['d-pdf'], includeBoard: false, target: out, fs: racing }), { code: 'EXPORT_DOCUMENT_UNAVAILABLE', message: /changed while/ });
    await assert.rejects(fs.stat(out), { code: 'ENOENT' });
    await fs.writeFile(path.join(project, 'docs', files.pdf.name), files.pdf.content);
    assert.deepEqual(await leftovers(root), []);
  });

  await t0.test('fflate loads from CommonJS in the main-process modules and the zip is a standard archive', async () => {
    const out = target();
    await documents.exportBundle({ manifest, documentIds: ['d-pdf', 'd-png', 'd-sch'], includeBoard: true, boardFiles, target: out });
    const raw = await fs.readFile(out);
    assert.equal(raw.readUInt32LE(0), 0x04034b50, 'local file header signature');
    assert.equal(raw.readUInt32LE(raw.length - 22), 0x06054b50, 'end of central directory');
    const entries = await unzip(out);
    assert.equal(Object.keys(entries).length, 5);
    for (const [name, data] of Object.entries(entries)) assert.ok(data.byteLength > 0, name);
  });
});

test('CI portability: fixtures are created under the canonical temp root, so paths the tests inject hooks on equal the paths the product resolves (Windows 8.3 short names, symlinked TMPDIR)', async () => {
  const { canonicalTempRoot, makeTempDir, isInsideTemp } = require('./canonical-temp.cjs');
  const realRoot = await makeTempDir('trace-canon-real-');
  const linkRoot = `${realRoot}-link`;
  // A directory link (junction on Windows, which needs no privilege) stands in for a temp root whose spelling differs from its canonical path.
  await fs.symlink(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = linkRoot;
    assert.notEqual(os.tmpdir(), await fs.realpath(os.tmpdir()), 'the emulated temp root is spelled differently from its canonical path');
    assert.equal(await canonicalTempRoot(), await fs.realpath(linkRoot));
    const directory = await makeTempDir('trace-canon-fixture-');
    assert.equal(directory, await fs.realpath(directory), 'the fixture directory is already canonical');
    assert.ok(!directory.startsWith(`${linkRoot}${path.sep}`), 'the link spelling never leaks into fixture paths');
    assert.ok(await isInsideTemp(directory), 'the cleanup guard accepts canonical fixture paths');
    assert.equal(await isInsideTemp(path.join(directory, '..', '..')), false, 'and refuses anything outside the temp root');
    const file = path.join(directory, 'Probe.cad');
    await fs.writeFile(file, 'x');
    assert.equal(await fs.realpath(file), file, 'a file written by a test resolves to exactly the string the test holds');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(linkRoot, { force: true }); await fs.rm(realRoot, { recursive: true, force: true });
  }
});
