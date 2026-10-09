'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { validateReceipt, yearAfter } = require('../electron/support.cjs');

const claim = 'c'.repeat(32);
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'jwk' });

function signedReceipt(paidAt) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    claim,
    paidAt,
    expiresAt: yearAfter(paidAt),
  })).toString('base64url');
  const signature = sign('sha256', Buffer.from(payload), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { payload, signature };
}

test('signed suppression ends at the exact expiry instant and future clock skew is bounded inclusively', () => {
  const paidAt = Date.UTC(2025, 4, 14, 9, 30);
  const expiresAt = yearAfter(paidAt);
  const receipt = signedReceipt(paidAt);

  assert.equal(validateReceipt(receipt, claim, expiresAt - 1, publicKey).expiresAt, expiresAt);
  assert.equal(validateReceipt(receipt, claim, expiresAt, publicKey), null);

  const now = Date.UTC(2026, 4, 14, 9, 30);
  const atSkewLimit = signedReceipt(now + 300_000);
  const beyondSkewLimit = signedReceipt(now + 300_001);
  assert.ok(validateReceipt(atSkewLimit, claim, now, publicKey));
  assert.equal(validateReceipt(beyondSkewLimit, claim, now, publicKey), null);
});
