'use strict';
const { randomBytes, createPublicKey, verify } = require('node:crypto');
const configuration = require('./support-verification.json');
const CLAIM = /^[a-f0-9]{32}$/;
const FILE = 'support-receipt.json';
const LIMIT = 8192;
const FEATURE = Object.freeze({ id: 'support-verification', hosts: [new URL(configuration.endpoint).hostname], methods: ['GET'], paths: ['/receipt'], allowQuery: true, headers: { Accept: 'application/json' }, maxBytes: LIMIT, timeoutMs: 8000, maxInFlight: 1, bodyStatuses: [200], optIn: { setting: 'supportVerification', bypassWithUserAction: true } });

function yearAfter(time) { const date = new Date(time), month = date.getUTCMonth(); date.setUTCFullYear(date.getUTCFullYear() + 1); if (date.getUTCMonth() !== month) date.setUTCDate(0); return date.getTime(); }
function validateReceipt(receipt, claim, now, publicKey = configuration.publicKey) {
  try {
    if (!publicKey || !CLAIM.test(claim) || !receipt || typeof receipt !== 'object' || Object.keys(receipt).sort().join(',') !== 'payload,signature' || typeof receipt.payload !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(receipt.payload) || typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) return null;
    const signature = Buffer.from(receipt.signature, 'base64url');
    if (signature.length !== 64 || !verify('sha256', Buffer.from(receipt.payload), { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature)) return null;
    const value = JSON.parse(Buffer.from(receipt.payload, 'base64url').toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'claim,expiresAt,paidAt,version' || value.version !== 1 || value.claim !== claim || !Number.isSafeInteger(value.paidAt) || value.paidAt < Date.UTC(2020, 0, 1) || value.paidAt > now + 300_000 || value.expiresAt !== yearAfter(value.paidAt) || value.expiresAt <= now) return null;
    return value;
  } catch { return null; }
}

function createSupportService({ store, egress, now = Date.now, config = configuration }) {
  let pending = null, nextCheck = 0;
  const read = async () => { try { const value = await store.read(FILE, { maxBytes: LIMIT }); return value && CLAIM.test(value.claim) ? value : null; } catch { return null; } };
  const status = value => { const receipt = value && validateReceipt(value.receipt, value.claim, now(), config.publicKey); return { status: receipt ? 'verified' : 'inactive', expiresAt: receipt?.expiresAt ?? null, available: config.enabled === true && !!config.publicKey }; };
  return Object.freeze({
    async status() { return status(await read()); },
    async prepare() {
      const old = await read();
      if (old) return { ...status(old), code: old.claim };
      // Atomic read-modify-write gives simultaneous windows one shared reference.
      const value = await store.update(FILE, current => current && CLAIM.test(current.claim) ? current : { claim: randomBytes(16).toString('hex') }, { maxBytes: LIMIT });
      return { ...status(value), code: value.claim };
    },
    async check() {
      if (pending) return pending;
      const value = await read();
      if (status(value).status === 'verified') return status(value);
      if (!config.enabled || !config.publicKey || !value) return { ...status(value), status: 'unavailable' };
      if (now() < nextCheck) return { ...status(value), status: 'pending' };
      nextCheck = now() + 10_000;
      pending = (async () => {
        const answer = await egress().request(FEATURE.id, `${config.endpoint}/receipt?claim=${value.claim}`, { userAction: true });
        if (!answer.ok || ![200, 404].includes(answer.status)) return { ...status(value), status: 'unavailable' };
        if (answer.status === 404) return { ...status(value), status: 'pending' };
        let receipt; try { receipt = JSON.parse(answer.body.toString('utf8')); } catch { return { ...status(value), status: 'unavailable' }; }
        if (!validateReceipt(receipt, value.claim, now(), config.publicKey)) return { ...status(value), status: 'unavailable' };
        try { await store.write(FILE, { claim: value.claim, receipt }, { maxBytes: LIMIT }); } catch { return { ...status(value), status: 'unavailable' }; }
        return status({ claim: value.claim, receipt });
      })().finally(() => { pending = null; });
      return pending;
    },
  });
}
module.exports = { FEATURE, createSupportService, validateReceipt, yearAfter };
