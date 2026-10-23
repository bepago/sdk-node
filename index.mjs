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
      /**
       * Verifica un webhook de bePago y devuelve el evento parseado.
       *
       * Chequea la firma HMAC y la FRESCURA del timestamp: por defecto rechaza
       * entregas fuera de ±5 minutos (configurable con `toleranceSeconds`). Lanza
       * si la firma no valida o el timestamp está fuera de la ventana.
       *
       * Expone `id` (header X-BePago-Event-Id, estable entre reintentos): guardá
       * los ids ya procesados para descartar duplicados de forma idempotente.
       *
       *   const evt = bp.webhooks.verify(secret, {
       *     id: req.headers['x-bepago-event-id'],
       *     timestamp: req.headers['x-webhook-timestamp'],
       *     signature: req.headers['x-webhook-signature'],
       *     body: rawBody, // el cuerpo EXACTO recibido, sin reserializar
       *   });
       *   if (seen.has(evt.id)) return; // duplicado
       *   seen.add(evt.id);
       *
       * @returns {{ id: string, event: string, livemode: boolean, data: object }}
       */
      verify(webhookSecret, { id, timestamp, body, signature }, opts = {}) {
        const toleranceMs = (opts.toleranceSeconds ?? 300) * 1000;
        const expected = createHmac('sha256', webhookSecret).update(String(timestamp) + body, 'utf8').digest('hex');
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(String(signature ?? ''), 'hex');
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bePago webhook: firma inválida');
        const age = Math.abs(Date.now() - Number(timestamp));
        if (!Number.isFinite(age) || age > toleranceMs) throw new Error('bePago webhook: timestamp fuera de la ventana permitida');
        const payload = JSON.parse(body);
        return { id: id ?? payload.id, event: payload.event, livemode: payload.livemode, data: payload.data };
      },
    },
  };
}
