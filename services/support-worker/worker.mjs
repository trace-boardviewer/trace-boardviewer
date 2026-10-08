// Payment payloads are authenticated in memory. No names, emails, amounts or raw bodies are stored or logged.
const encoder = new TextEncoder();
const CLAIM = /^[a-f0-9]{32}$/;
const MAX_BODY = 64 * 1024;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i); return difference === 0; };

export function yearAfter(paidAt) {
  const date = new Date(paidAt), month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  // A leap-day payment expires on the last day of February the following year.
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.getTime();
}

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('size');
  if (!request.body) throw new Error('body');
  const reader = request.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BODY) { await reader.cancel(); throw new Error('size'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
}

export async function stripeSignature(raw, header, secret, now) {
  if (!secret || typeof header !== 'string' || header.length > 2048) return false;
  const fields = header.split(',').map(x => x.split('='));
  const timestamps = fields.filter(x => x[0] === 't');
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0][1])) return false;
  const timestamp = timestamps[0][1];
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`)));
  return fields.some(x => x[0] === 'v1' && equal(x[1], signature));
}

async function record(env, provider, eventId, claim, paidAt, now) {
  if (!CLAIM.test(claim ?? '') || typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 160 || !Number.isSafeInteger(paidAt) || paidAt < Date.UTC(2020, 0, 1) || paidAt > now + 300_000) return;
  const eventHash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${provider}:${eventId}`)));
  await env.DB.prepare('INSERT OR IGNORE INTO support_payments(event_hash, claim, paid_at, expires_at) VALUES (?, ?, ?, ?)').bind(eventHash, claim, paidAt, yearAfter(paidAt)).run();
}

async function authenticated(env, provider, now) {
  await env.DB.prepare('INSERT INTO support_webhook_checks(provider, verified_at) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET verified_at = excluded.verified_at').bind(provider, now).run();
}

async function handle(request, env, now) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    if (!env.DB || !env.RECEIPT_PRIVATE_JWK) return json({ status: 'unconfigured' });
    const challenge = url.searchParams.get('challenge');
    if (challenge === null) return json({ status: 'ready' });
    if (!CLAIM.test(challenge) || url.searchParams.getAll('challenge').length !== 1 || [...url.searchParams.keys()].some(x => x !== 'challenge')) return json({ status: 'invalid' }, 400);
    // Domain separation prevents a public health proof from being used as a payment receipt.
    const key = await crypto.subtle.importKey('jwk', JSON.parse(env.RECEIPT_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`TRACE support health v1:${challenge}`)));
    return json({ status: 'ready', challenge, signature });
  }
  if (!env.DB || !env.RECEIPT_PRIVATE_JWK) return json({ status: 'unavailable' }, 503);
  if (url.pathname === '/receipt' && request.method === 'GET') {
    const claim = url.searchParams.get('claim');
    if (!CLAIM.test(claim ?? '') || [...url.searchParams.keys()].some(x => x !== 'claim') || url.searchParams.getAll('claim').length !== 1) return json({ status: 'invalid' }, 400);
    const payment = await env.DB.prepare('SELECT paid_at, expires_at FROM support_payments WHERE claim = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1').bind(claim, now).first();
    if (!payment) return json({ status: 'pending' }, 404);
    const payload = base64url(encoder.encode(JSON.stringify({ version: 1, claim, paidAt: payment.paid_at, expiresAt: payment.expires_at })));
    const key = await crypto.subtle.importKey('jwk', JSON.parse(env.RECEIPT_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(payload)));
    return json({ payload, signature });
  }
  if (request.method !== 'POST' || !['/webhooks/stripe', '/webhooks/kofi'].includes(url.pathname) || url.search) return json({ status: 'invalid' }, 404);
  const raw = await readBody(request);
  if (url.pathname === '/webhooks/stripe') {
    if (!env.STRIPE_WEBHOOK_SECRET) return json({ status: 'unavailable' }, 503);
    if (!await stripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, now)) return json({ status: 'invalid' }, 401);
    await authenticated(env, 'stripe', now);
    const event = JSON.parse(raw), session = event.data?.object;
    if (event.livemode === true && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && session?.object === 'checkout.session' && session.payment_status === 'paid' && Number.isSafeInteger(session.amount_total) && session.amount_total > 0 && env.STRIPE_PAYMENT_LINK_ID && session.payment_link === env.STRIPE_PAYMENT_LINK_ID) {
      await record(env, 'stripe', session.id, session.client_reference_id, event.created * 1000, now);
    }
  } else {
    if (!env.KOFI_VERIFICATION_TOKEN) return json({ status: 'unavailable' }, 503);
    const form = new URLSearchParams(raw);
    if (form.getAll('data').length !== 1) return json({ status: 'invalid' }, 400);
    const payment = JSON.parse(form.get('data'));
    if (!equal(payment.verification_token, env.KOFI_VERIFICATION_TOKEN)) return json({ status: 'invalid' }, 401);
    await authenticated(env, 'kofi', now);
    // The supporter puts the app's reference in the payment message. Ambiguous or missing references never grant a receipt.
    const claims = [...String(payment.message ?? '').matchAll(/\bTRACE-([a-f0-9]{32})\b/g)];
    if (claims.length === 1 && ['Tip', 'Donation', 'Subscription'].includes(payment.type) && Number.isFinite(Number(payment.amount)) && Number(payment.amount) > 0) {
      await record(env, 'kofi', payment.kofi_transaction_id, claims[0][1], Date.parse(payment.timestamp), now);
    }
  }
  return json({ status: 'received' });
}

export default { async fetch(request, env) { try { return await handle(request, env, Date.now()); } catch { return json({ status: 'unavailable' }, 503); } }, async scheduled(_event, env) { await env.DB.prepare('DELETE FROM support_payments WHERE expires_at <= ?').bind(Date.now() - 30 * 86400_000).run(); } };
