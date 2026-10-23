/**
 * bePago SDK — Node.js (18+, zero dependencies).
 *
 * Usage:
 *   import BePago from 'bepago';
 *   const bp = BePago('sk_test_…');
 *   const charge = await bp.charges.create({ reference: 'order-1', currency: 'PYG', amount: 150000, description: 'Test' });
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Firma canónica v2 de un request (misma que valida la API).
 * `body` es el cuerpo YA serializado (string); cadena vacía si no hay body.
 */
export function computeSignatureV2({ secret, timestamp, nonce, method, path, idempotencyKey = '', body = '' }) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = ['v2', timestamp, nonce, method.toUpperCase(), path, idempotencyKey ?? '', bodyHash].join('\n');
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export default function BePago(secret, opts = {}) {
  const base = opts.baseUrl ?? 'https://bepago.com/api';
  // The key ID is the part before the first underscore pair: pk_test_xxx or sk_test_xxx
  // But for the API, X-Api-Key is the full key ID (pk_test_…), and the secret is sk_test_…
  // Convention: the user passes the secret (sk_), and the key ID (pk_) is derived or passed separately.
  const keyId = opts.keyId ?? secret.replace(/^sk_/, 'pk_');

  function sign(method, path, body, idempotencyKey) {
    const timestamp = String(Date.now());
    const nonce = randomUUID().replaceAll('-', '');
    const bodyStr = body != null ? JSON.stringify(body) : '';
    const signature = computeSignatureV2({ secret, timestamp, nonce, method, path, idempotencyKey, body: bodyStr });
    return { timestamp, nonce, signature, bodyStr };
  }

  async function request(method, path, body, extra = {}) {
    const { timestamp, nonce, signature, bodyStr } = sign(method, path, body, extra.idempotencyKey);
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': keyId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature-Version': '2',
      'X-Signature': signature,
    };
    if (extra.idempotencyKey) headers['X-Idempotency-Key'] = extra.idempotencyKey;
    const res = await fetch(base + path, { method, headers, body: bodyStr || undefined });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
      err.code = data?.error?.code;
      err.status = res.status;
      err.response = data;
      throw err;
    }
    return data;
  }

  return {
    charges: {
      create: (params) => request('POST', '/v1/charges', params),
      get: (ref) => request('GET', `/v1/charges/${encodeURIComponent(ref)}`),
      refund: (ref, reason) => request('POST', `/v1/charges/${encodeURIComponent(ref)}/refund`, { reason }),
      balance: () => request('GET', '/v1/charges/balance'),
    },
    payouts: {
      create: (params, idempotencyKey) => request('POST', '/v1/payouts', params, { idempotencyKey }),
      get: (id) => request('GET', `/v1/payouts/${encodeURIComponent(id)}`),
      cancel: (id) => request('POST', `/v1/payouts/${encodeURIComponent(id)}/cancel`),
      balance: () => request('GET', '/v1/balance'),
    },
    webhooks: {
      verify: (webhookSecret, timestamp, body, signature) => {
        const expected = createHmac('sha256', webhookSecret).update(timestamp + body, 'utf8').digest('hex');
        return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
      },
    },
  };
}
