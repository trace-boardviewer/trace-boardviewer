'use strict';
const { randomBytes, createPublicKey, verify } = require('node:crypto');
const configuration = require('./support-verification.json');
const CLAIM = /^[a-f0-9]{32}$/;
const FILE = 'support-receipt.json';
const LIMIT = 8192;
const MISSING = Symbol('missing support receipt');
const FEATURE = Object.freeze({ id: 'support-verification', hosts: [new URL(configuration.endpoint).hostname], methods: ['GET'], paths: ['/receipt'], allowQuery: true, headers: { Accept: 'application/json' }, maxBytes: LIMIT, timeoutMs: 8000, maxInFlight: 1, bodyStatuses: [200], optIn: { setting: 'supportVerification', bypassWithUserAction: true } });

function yearAfter(time) { const date = new Date(time), month = date.getUTCMonth(); date.setUTCFullYear(date.getUTCFullYear() + 1); if (date.getUTCMonth() !== month) date.setUTCDate(0); return date.getTime(); }
function validateReceipt(receipt, claim, now, publicKey = configuration.publicKey) {
  try {
    if (!publicKey || typeof claim !== 'string' || !CLAIM.test(claim) || !receipt || typeof receipt !== 'object' || Object.keys(receipt).sort().join(',') !== 'payload,signature' || typeof receipt.payload !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(receipt.payload) || typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) return null;
    const signature = Buffer.from(receipt.signature, 'base64url');
    if (signature.length !== 64 || !verify('sha256', Buffer.from(receipt.payload), { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature)) return null;
    const value = JSON.parse(Buffer.from(receipt.payload, 'base64url').toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'claim,expiresAt,paidAt,version' || value.version !== 1 || value.claim !== claim || !Number.isSafeInteger(value.paidAt) || value.paidAt < Date.UTC(2020, 0, 1) || value.paidAt > now + 300_000 || value.expiresAt !== yearAfter(value.paidAt) || value.expiresAt <= now) return null;
    return value;
  } catch { return null; }
}

function createSupportService({ store, egress, now = Date.now, config = configuration }) {
  let pending = null, nextCheck = 0;
  const read = async () => {
    try {
      const value = await store.read(FILE, { maxBytes: LIMIT, missing: MISSING });
      if (value === MISSING) return { kind: 'missing' };
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.claim !== 'string' || !CLAIM.test(value.claim)) return { kind: 'damaged' };
      return { kind: 'present', value };
    } catch { return { kind: 'unreadable' }; }
  };
  const available = config.enabled === true && !!config.publicKey;
  const status = value => { const receipt = value && validateReceipt(value.receipt, value.claim, now(), config.publicKey); return { status: receipt ? 'verified' : 'inactive', expiresAt: receipt?.expiresAt ?? null, available }; };
  const unavailable = () => ({ status: 'unavailable', expiresAt: null, available });
  return Object.freeze({
    async status() {
      const result = await read();
      if (result.kind === 'unreadable' || result.kind === 'damaged') return unavailable();
      return status(result.kind === 'present' ? result.value : null);
    },
    async prepare() {
      const existing = await read();
      if (existing.kind === 'present') return { ...status(existing.value), code: existing.value.claim };
      if (existing.kind !== 'missing') return { ...unavailable(), code: '' };
      // Atomic read-modify-write gives simultaneous windows one shared reference.
      try {
        const value = await store.update(FILE, current => {
          if (current === null) return { claim: randomBytes(16).toString('hex') };
          if (current && typeof current === 'object' && !Array.isArray(current) && typeof current.claim === 'string' && CLAIM.test(current.claim)) return current;
          throw new Error('Support receipt storage is damaged.');
        }, { maxBytes: LIMIT });
        if (!value || typeof value.claim !== 'string' || !CLAIM.test(value.claim)) return { ...unavailable(), code: '' };
        return { ...status(value), code: value.claim };
      } catch { return { ...unavailable(), code: '' }; }
    },
    async check() {
      if (pending) return pending;
      const result = await read();
      if (result.kind === 'unreadable' || result.kind === 'damaged') return unavailable();
      const value = result.kind === 'present' ? result.value : null;
      if (status(value).status === 'verified') return status(value);
      if (!available || !value) return unavailable();
      if (now() < nextCheck) return { ...status(value), status: 'pending' };
      pending = (async () => {
        let answer;
        try { answer = await egress().request(FEATURE.id, `${config.endpoint}/receipt?claim=${value.claim}`, { userAction: true }); }
        catch { return { ...status(value), status: 'unavailable' }; }
        if (!answer || typeof answer !== 'object' || !answer.ok || ![200, 404].includes(answer.status)) return { ...status(value), status: 'unavailable' };
        if (answer.status === 404) { nextCheck = now() + 10_000; return { ...status(value), status: 'pending' }; }
        let receipt; try { receipt = JSON.parse(answer.body.toString('utf8')); } catch { return { ...status(value), status: 'unavailable' }; }
        if (!validateReceipt(receipt, value.claim, now(), config.publicKey)) return { ...status(value), status: 'unavailable' };
        try { await store.write(FILE, { claim: value.claim, receipt }, { maxBytes: LIMIT }); } catch { nextCheck = 0; return { ...status(value), status: 'unavailable' }; }
        nextCheck = now() + 10_000;
        return status({ claim: value.claim, receipt });
      })().finally(() => { pending = null; });
      return pending;
    },
  });
}
module.exports = { FEATURE, createSupportService, validateReceipt, yearAfter };
