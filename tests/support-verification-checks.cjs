'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { generateKeyPairSync, sign, verify, createHmac } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { validateReceipt, createSupportService, FEATURE } = require('../electron/support.cjs');
const { createEgress } = require('../electron/net/egress.cjs');
const now = Date.UTC(2026, 9, 8), claim = 'a'.repeat(32);
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'jwk' });
function receipt(paidAt = now, overrides = {}) {
  const expiry = new Date(paidAt); expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  if (new Date(paidAt).getUTCMonth() !== expiry.getUTCMonth()) expiry.setUTCDate(0);
  const payload = Buffer.from(JSON.stringify({ version: 1, claim, paidAt, expiresAt: expiry.getTime(), ...overrides })).toString('base64url');
  return { payload, signature: sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
}
test('offline receipt: signature, app reference, exact year and expiry are required', () => {
  assert.equal(validateReceipt(receipt(), claim, now, publicKey).paidAt, now);
  assert.equal(validateReceipt(receipt(), 'b'.repeat(32), now, publicKey), null);
  assert.equal(validateReceipt({ ...receipt(), signature: 'a'.repeat(86) }, claim, now, publicKey), null);
  assert.equal(validateReceipt(receipt(now, { expiresAt: now + 1 }), claim, now, publicKey), null);
  assert.equal(validateReceipt(receipt(), claim, Date.UTC(2027, 9, 8), publicKey), null);
  const leap = Date.UTC(2024, 1, 29, 12);
  assert.equal(validateReceipt(receipt(leap), claim, leap, publicKey).expiresAt, Date.UTC(2025, 1, 28, 12));
  assert.equal(validateReceipt(receipt(now + 600_000), claim, now, publicKey), null);
});
test('status is local; only an explicit check uses egress, stores a signed receipt and hides the code in the activity log', async () => {
  let value = { claim }, requests = 0;
  const layer = createEgress({ version: '1.3.0', isEnabled: () => false, fetchImpl: async url => { requests++; assert.equal(new URL(url).searchParams.get('claim'), claim); return new Response(JSON.stringify(receipt()), { status: 200 }); } });
  layer.register(FEATURE);
  const store = { read: async () => value, write: async (_name, next) => { value = next; } };
  const service = createSupportService({ store, egress: () => layer, now: () => now, config: { enabled: true, endpoint: 'https://' + FEATURE.hosts[0], publicKey } });
  assert.equal((await service.status()).status, 'inactive'); assert.equal(requests, 0);
  assert.equal((await service.check()).status, 'verified'); assert.equal(requests, 1);
  assert.equal((await service.check()).status, 'verified'); assert.equal(requests, 1);
  const restarted = createSupportService({ store, egress: () => { throw new Error('offline'); }, now: () => now, config: { enabled: true, publicKey } });
  assert.equal((await restarted.status()).status, 'verified');
  assert.ok(!JSON.stringify(layer.activity()).includes(claim));
  assert.deepEqual(Object.keys(value).sort(), ['claim', 'receipt']);
});
test('network failure, pending payment, forged receipt and failed local save never grant suppression', async () => {
  for (const answer of [{ ok: false }, { ok: true, status: 404 }, { ok: true, status: 200, body: Buffer.from('{}') }]) {
    const service = createSupportService({ store: { read: async () => ({ claim }) }, egress: () => ({ request: async () => answer }), now: () => now, config: { enabled: true, endpoint: 'https://example.invalid', publicKey } });
    assert.notEqual((await service.check()).status, 'verified');
  }
  const service = createSupportService({ store: { read: async () => ({ claim }), write: async () => { throw new Error('disk'); } }, egress: () => ({ request: async () => ({ ok: true, status: 200, body: Buffer.from(JSON.stringify(receipt())) }) }), now: () => now, config: { enabled: true, endpoint: 'https://example.invalid', publicKey } });
  assert.equal((await service.check()).status, 'unavailable');
});
test('Worker: real database deduplicates paid sessions; auth, live mode, matching link and positive paid amount are mandatory', async t => {
  const worker = (await import(pathToFileURL(path.resolve(__dirname, '../services/support-worker/worker.mjs')))).default;
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(path.resolve(__dirname, '../services/support-worker/schema.sql'), 'utf8'));
  const DB = { prepare(sql) { return { bind(...args) { return { run: async () => db.prepare(sql).run(...args), first: async () => db.prepare(sql).get(...args) }; } }; } };
  const env = { DB, RECEIPT_PRIVATE_JWK: JSON.stringify(keys.privateKey.export({ format: 'jwk' })), STRIPE_WEBHOOK_SECRET: 'synthetic-webhook-secret', STRIPE_PAYMENT_LINK_ID: 'plink_synthetic', KOFI_VERIFICATION_TOKEN: 'synthetic-kofi-token' };
  const paid = Date.now();
  const event = { id: 'evt_synthetic', livemode: true, type: 'checkout.session.completed', created: Math.floor(paid / 1000), data: { object: { object: 'checkout.session', id: 'cs_synthetic', payment_status: 'paid', amount_total: 500, payment_link: 'plink_synthetic', client_reference_id: claim } } };
  async function send(data, valid = true) {
    const raw = JSON.stringify(data), timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    return worker.fetch(new Request('https://example.invalid/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${timestamp},v1=${valid ? signature : '0'.repeat(64)}` } }), env);
  }
  assert.equal((await send(event, false)).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_webhook_checks').get().n, 0);
  for (const alter of [x => { x.livemode = false; }, x => { x.data.object.payment_status = 'unpaid'; }, x => { x.data.object.amount_total = 0; }, x => { x.data.object.payment_link = 'plink_other'; }]) { const copy = structuredClone(event); alter(copy); await send(copy); }
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_payments').get().n, 0);
  await Promise.all([send(event), send(event)]);
  await send({ ...event, type: 'checkout.session.async_payment_succeeded', id: 'evt_other' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_payments').get().n, 1);
  const response = await worker.fetch(new Request(`https://example.invalid/receipt?claim=${claim}`), env);
  assert.equal(response.status, 200);
  assert.ok(validateReceipt(await response.json(), claim, Date.now(), publicKey));
  const tip = { verification_token: env.KOFI_VERIFICATION_TOKEN, message: `TRACE-${claim}`, kofi_transaction_id: 'synthetic-tip', type: 'Tip', amount: '5.00', timestamp: new Date().toISOString(), email: 'private-canary@example.invalid', from_name: 'Private Canary' };
  const kofi = data => worker.fetch(new Request('https://example.invalid/webhooks/kofi', { method: 'POST', body: new URLSearchParams({ data: JSON.stringify(data) }) }), env);
  assert.equal((await kofi({ ...tip, verification_token: 'wrong' })).status, 401);
  await kofi({ ...tip, message: `TRACE-${claim} TRACE-${claim}` });
  for (const invalid of [{ type: 'Shop Order' }, { type: 'Commission' }, { amount: 'Infinity' }, { amount: '-1' }, { amount: '0' }]) await kofi({ ...tip, ...invalid });
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_payments').get().n, 1);
  await kofi(tip); await kofi(tip);
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_payments').get().n, 2);
  for (const type of ['Donation', 'Subscription']) {
    await kofi({ ...tip, type, kofi_transaction_id: `synthetic-${type}` });
    await kofi({ ...tip, type, kofi_transaction_id: `synthetic-${type}` });
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM support_payments').get().n, 4);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM support_payments').all()).includes('Canary'));
  assert.equal((await worker.fetch(new Request('https://example.invalid/receipt?claim=wrong'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://example.invalid/webhooks/kofi', { method: 'POST', body: 'x'.repeat(65537) }), env)).status, 503);
  assert.equal((await worker.fetch(new Request('https://example.invalid/receipt?claim=' + claim), {})).status, 503);
  assert.deepEqual(db.prepare('SELECT provider FROM support_webhook_checks ORDER BY provider').all().map(row => row.provider), ['kofi', 'stripe']);
  const health = await worker.fetch(new Request('https://example.invalid/health?challenge=' + claim), env);
  assert.equal(health.status, 200);
  const proof = await health.json();
  assert.deepEqual(Object.keys(proof).sort(), ['challenge', 'signature', 'status']);
  assert.ok(verify('sha256', Buffer.from('TRACE support health v1:' + claim), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof.signature, 'base64url')));
  assert.equal(validateReceipt({ payload: claim, signature: proof.signature }, claim, Date.now(), publicKey), null);
  assert.equal((await worker.fetch(new Request('https://example.invalid/health?challenge=wrong'), env)).status, 400);
});
