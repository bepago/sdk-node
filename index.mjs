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

  const api = {
    charges: {
      create: (params) => request('POST', '/v1/charges', params),
      get: (ref) => request('GET', `/v1/charges/${encodeURIComponent(ref)}`),
      refund: (ref, reason) => request('POST', `/v1/charges/${encodeURIComponent(ref)}/refund`, { reason }),
      balance: () => request('GET', '/v1/charges/balance'),
      /**
       * Confirma el estado REAL de un cobro consultando la API (fuente de verdad).
       * Usalo para decidir si entregás: nunca confíes en el navegador ni en el
       * iframe. Devuelve `{ paid, status, charge }` — `paid` es true solo si el
       * cobro figura `paid` en bePago.
       *
       *   const { paid, charge } = await bp.charges.confirm(orderId);
       *   if (paid && charge.amount === order.amount) entregar();
       *
       * @returns {Promise<{ paid: boolean, status: string, charge: object }>}
       */
      async confirm(ref) {
        const charge = await request('GET', `/v1/charges/${encodeURIComponent(ref)}`);
        const status = charge?.status ?? charge?.data?.status;
        return { paid: status === 'paid', status, charge };
      },
    },
    payouts: {
      create: (params, idempotencyKey) => request('POST', '/v1/payouts', params, { idempotencyKey }),
      get: (id) => request('GET', `/v1/payouts/${encodeURIComponent(id)}`),
      cancel: (id) => request('POST', `/v1/payouts/${encodeURIComponent(id)}/cancel`),
      balance: () => request('GET', '/v1/balance'),
      /**
       * Lotes de pagos masivos. `create` carga el lote entero (hasta 1000 pagos);
       * queda pendiente de aprobación en el panel (cuatro ojos) salvo que el
       * comercio tenga habilitada la auto-aprobación por API.
       *
       *   const lote = await bp.payouts.batches.create({
       *     payouts: [{ amount: 150000, destination: { type: 'alias', alias: 'juan.perez' }, external_id: 'premio-88' }],
       *   }, 'idem-key-unica');
       *   await bp.payouts.batches.get(lote.id);
       */
      batches: {
        create: (params, idempotencyKey) => request('POST', '/v1/payouts/batches', params, { idempotencyKey }),
        get: (id) => request('GET', `/v1/payouts/batches/${encodeURIComponent(id)}`),
      },
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

      /**
       * Crea un manejador de webhooks seguro-por-defecto. Verifica firma y
       * frescura (±5 min), descarta duplicados por X-BePago-Event-Id y SOLO
       * invoca `onPaid` con eventos `charge.paid` válidos y no vistos. Siempre
       * responde 200 a entregas válidas (aunque sean duplicadas, para que
       * bePago deje de reintentar) y 400 a firmas/timestamps inválidos.
       *
       * No montes el parser de JSON del framework delante: el handler necesita
       * el cuerpo CRUDO (string/Buffer) para validar la firma byte a byte. Usá
       * los adapters `bp.webhooks.express()` / `bp.webhooks.fastify()` que ya
       * resuelven eso.
       *
       *   const wh = bp.webhooks.handler({
       *     secret: process.env.BEPAGO_WEBHOOK_SECRET,
       *     onPaid: async ({ reference, data }) => { await entregar(reference); },
       *     onEvent: async (evt) => {},            // opcional: todos los eventos
       *     store: myRedisStore,                   // opcional: persistir ids vistos
       *   });
       *
       * `store` por defecto es un Set en memoria. Para no entregar dos veces
       * tras un reinicio, pasá un store con `has(id)` y `add(id)` (pueden ser
       * async) respaldado por tu base.
       *
       * @returns {{ process(input): Promise<{status:number, body:string, duplicate:boolean, ok:boolean}>, express(): Function, fastify(): Function }}
       */
      handler(config = {}) {
        const { secret, onPaid, onEvent } = config;
        if (!secret) throw new Error('bePago webhooks.handler: falta `secret`');
        const seen = config.store ?? defaultSeenStore();

        async function process({ headers = {}, body }) {
          const h = lowerHeaders(headers);
          const raw = toRawBody(body);
          let evt;
          try {
            evt = api.webhooks.verify(secret, {
              id: h['x-bepago-event-id'],
              timestamp: h['x-webhook-timestamp'],
              signature: h['x-webhook-signature'],
              body: raw,
            }, config);
          } catch (err) {
            return { status: 400, body: JSON.stringify({ error: 'invalid_signature' }), duplicate: false, ok: false };
          }
          if (await seen.has(evt.id)) {
            return { status: 200, body: JSON.stringify({ received: true, duplicate: true }), duplicate: true, ok: true };
          }
          await seen.add(evt.id);
          try {
            if (typeof onEvent === 'function') await onEvent(evt);
            if (evt.event === 'charge.paid' && typeof onPaid === 'function') {
              await onPaid({ reference: evt.data?.reference, data: evt.data, event: evt });
            }
          } catch (err) {
            return { status: 500, body: JSON.stringify({ error: 'handler_error' }), duplicate: false, ok: false };
          }
          return { status: 200, body: JSON.stringify({ received: true }), duplicate: false, ok: true };
        }

        return {
          process,
          /** Middleware Express. Montalo con el raw body: app.post(url, express.raw({type:'*&#47;*'}), wh.express()) */
          express() {
            return async (req, res) => {
              const r = await process({ headers: req.headers, body: req.body });
              res.status(r.status).set('content-type', 'application/json').send(r.body);
            };
          },
          /** Handler Fastify. Registrá un parser que deje el raw body (ver ejemplo en /docs). */
          fastify() {
            return async (req, reply) => {
              const r = await process({ headers: req.headers, body: req.rawBody ?? req.body });
              reply.code(r.status).header('content-type', 'application/json').send(r.body);
            };
          },
        };
      },
    },
  };
  return api;
}

/** Store de ids vistos en memoria (por defecto). Para producción multi-proceso, pasá uno respaldado por tu base. */
function defaultSeenStore() {
  const set = new Set();
  return { has: (id) => set.has(id), add: (id) => { set.add(id); } };
}

function lowerHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

function toRawBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  // Último recurso: si el framework ya parseó a objeto, reserializar romperá la
  // firma. Lo exponemos igual para que falle ruidoso y no silencioso.
  return typeof body === 'object' ? JSON.stringify(body) : String(body);
}
