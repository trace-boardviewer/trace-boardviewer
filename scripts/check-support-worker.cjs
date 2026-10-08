'use strict';
// Explicit deployment check of the public health endpoint. Sends no payment data or credentials.
const { createEgress } = require('../electron/net/egress.cjs');
const { randomBytes, createPublicKey, verify } = require('node:crypto');
const { endpoint, publicKey } = require('../electron/support-verification.json');
const { FEATURE, createSupportService } = require('../electron/support.cjs');
const { version } = require('../package.json');
const feature = { id: 'support-health', hosts: [new URL(endpoint).hostname], paths: ['/health'], allowQuery: true, methods: ['GET'], maxBytes: 1024, timeoutMs: 8000, headers: { Accept: 'application/json' }, bodyStatuses: [200] };
(async () => {
  const layer = createEgress({ version, fetchImpl: (url, init) => fetch(url, init) }); layer.register(feature);
  const challenge = randomBytes(16).toString('hex');
  const answer = await layer.request(feature.id, endpoint + '/health?challenge=' + challenge, { userAction: true });
  if (!answer.ok || answer.status !== 200) { console.log(JSON.stringify({ status: 'unavailable', httpStatus: answer.status ?? null, error: answer.error ?? null })); process.exitCode = 1; return; }
  let value; try { value = JSON.parse(answer.body.toString('utf8')); } catch {}
  if (!['ready', 'unconfigured'].includes(value?.status)) { console.log(JSON.stringify({ status: 'invalid-response' })); process.exitCode = 1; return; }
  const keyMatches = value.status === 'ready' && value.challenge === challenge && typeof value.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.signature) && verify('sha256', Buffer.from('TRACE support health v1:' + challenge), { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(value.signature, 'base64url'));
  let receiptCheck = null;
  if (keyMatches) {
    layer.register(FEATURE);
    const claim = randomBytes(16).toString('hex');
    const service = createSupportService({ store: { read: async () => ({ claim }) }, egress: () => layer, config: { enabled: true, endpoint, publicKey } });
    receiptCheck = (await service.check()).status;
  }
  console.log(JSON.stringify({ status: value.status, httpStatus: answer.status, keyMatches, receiptCheck }));
  if (value.status === 'ready' && !keyMatches) process.exitCode = 1;
  if (keyMatches && receiptCheck !== 'pending') process.exitCode = 1;
})().catch(() => { console.log(JSON.stringify({ status: 'unavailable' })); process.exitCode = 1; });
