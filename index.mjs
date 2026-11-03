/**
 * bePago SDK — Node.js (18+, sin dependencias: solo módulos de Node).
 *
 * Usage:
 *   import BePago from 'bepago';          // o: const BePago = require('bepago');
 *   const bp = BePago('sk_test_…');   // el Key ID (pk_…) sale del secreto; con claves viejas: { keyId: 'pk_…' }
 *   const charge = await bp.charges.create({ reference: 'order-1', currency: 'PYG', amount: 150000, description: 'Test' });
 *   // opcional: method: 'qr_sip' | 'pix' | 'qr_ar' (uno de los activos del comercio) fuerza ese método
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

/** Error de la API o de la conexión: `status` (HTTP; 0 sin respuesta), `code`, `requestId`, `details`. */
export class BePagoError extends Error {
  constructor(message, { status = 0, code = null, requestId = null, details = null, response = null } = {}) {
    super(message);
    this.name = 'BePagoError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
    this.response = response;
  }
}

/**
 * Key ID público (pk_…) de un secreto. Los secretos de ahora llevan adentro el
 * cuerpo de su Key ID (sk_<modo>_<16 del Key ID><43>); los anteriores no, y con
 * esos devuelve null (hay que pasar el Key ID aparte).
 */
export function keyIdFromSecret(secret) {
  const m = /^sk_(test|live)_([A-Za-z0-9_-]+)$/.exec(String(secret ?? ''));
  return m && m[2].length === 59 ? `pk_${m[1]}_${m[2].slice(0, 16)}` : null;
}

const MISSING_KEY_ID = 'bePago: esta clave secreta es de un formato anterior y no trae su Key ID adentro. '
  + "Pasalo aparte: BePago(secret, { keyId: 'pk_…' }). Está completo, con botón Copiar, en Integraciones › Claves de API (columna Clave pública).";

export default function BePago(secret, opts = {}) {
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('bePago: falta la clave secreta (sk_test_… o sk_live_…). La creás en Integraciones › Claves de API.');
  }
  // https://bepago.com/api — acepta también la dirección con /v1 al final (como la muestra el panel)
  const base = String(opts.baseUrl ?? 'https://bepago.com/api').replace(/\/+$/, '').replace(/\/v1$/, '');
  // Sin Key ID (secreto del formato anterior) igual se puede verificar webhooks; la API lo pide al primer request
  const keyId = opts.keyId ?? keyIdFromSecret(secret);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Reintentos automáticos SOLO cuando repetir no puede duplicar nada: GET
  // (lectura) ante red caída, tiempo agotado o 502/503/504; POST con clave de
  // idempotencia (pagos y lotes) ante red caída o tiempo agotado (la misma
  // clave = el mismo pago). Un POST sin clave (cobros, reembolsos) nunca.
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2));

  function sign(method, path, body, idempotencyKey) {
    const timestamp = String(Date.now());
    const nonce = randomUUID().replaceAll('-', '');
    const bodyStr = body != null ? JSON.stringify(body) : '';
    const signature = computeSignatureV2({ secret, timestamp, nonce, method, path, idempotencyKey, body: bodyStr });
    return { timestamp, nonce, signature, bodyStr };
  }

  async function request(method, path, body, extra = {}) {
    if (!keyId) throw new BePagoError(MISSING_KEY_ID, { code: 'missing_key_id' });
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(method, path, body, extra);
      } catch (err) {
        if (attempt >= maxRetries || !retryable(err, method, extra.idempotencyKey)) throw err;
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  async function requestOnce(method, path, body, extra) {
    // Cada intento con su propio timestamp y nonce: un nonce no se usa dos veces
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
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError';
      // Sin respuesta no se sabe si la API lo procesó: en pagos, reintentá con la MISMA idempotencyKey.
      throw new BePagoError(timeout ? `bePago: sin respuesta en ${timeoutMs} ms` : `bePago: no se pudo conectar con ${base} (${e?.cause?.code ?? e?.message ?? e})`,
        { code: timeout ? 'timeout' : 'network_error' });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* respuesta que no es JSON (proxy, 502) */ }
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new BePagoError(e.message ?? `bePago: HTTP ${res.status}${data ? '' : ' (respuesta sin JSON)'}`, {
        status: res.status, code: e.code ?? (data ? null : 'invalid_response'), requestId: e.request_id ?? res.headers.get('x-request-id'),
        details: e.details ?? null, response: data ?? text,
      });
    }
    if (data === null && text) throw new BePagoError('bePago: respuesta sin JSON', { status: res.status, code: 'invalid_response', response: text });
    return data;
  }

  const query = (params) => {
    const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    return q ? `?${q}` : '';
  };

  const api = {
    charges: {
      create: (params) => request('POST', '/v1/charges', params),
      get: (ref) => request('GET', `/v1/charges/${encodeURIComponent(ref)}`),
      /** Cobros del más nuevo al más viejo: { data, has_more, next_cursor }. Filtros: limit, status, from, to, cursor. */
      list: (params) => request('GET', `/v1/charges${query(params)}`),
      /** Cancela un cobro todavía sin pagar (created/pending). */
      cancel: (ref) => request('POST', `/v1/charges/${encodeURIComponent(ref)}/cancel`),
      refund: (ref, reason) => request('POST', `/v1/charges/${encodeURIComponent(ref)}/refund`, { reason }),
      balance: () => request('GET', '/v1/charges/balance'),
      /**
       * Confirma el estado REAL de un cobro consultando la API (fuente de verdad).
       * Usalo para decidir si entregás: nunca confíes en el navegador ni en el
       * iframe. Devuelve `{ paid, status, charge }` — `paid` es true si el
       * cobro figura `paid` o `settled` (pagado y ya liquidado) en bePago.
       *
       *   const { paid, charge } = await bp.charges.confirm(orderId);
       *   if (paid && charge.amount === order.amount) entregar();
       *
       * @returns {Promise<{ paid: boolean, status: string, charge: object }>}
       */
      async confirm(ref) {
        const charge = await request('GET', `/v1/charges/${encodeURIComponent(ref)}`);
        const status = charge?.status ?? charge?.data?.status;
        return { paid: status === 'paid' || status === 'settled', status, charge };
      },
    },
    payouts: {
      /** `idempotencyKey` es OBLIGATORIO (mín. 8 caracteres), igual que en la API: el mismo valor = el mismo pago. */
      create: (params, idempotencyKey) => request('POST', '/v1/payouts', params, { idempotencyKey: requireIdempotencyKey(idempotencyKey) }),
      get: (id) => request('GET', `/v1/payouts/${encodeURIComponent(id)}`),
      /** Pagos del más nuevo al más viejo: { data, has_more, next_cursor }. Filtros: limit, status, from, to, cursor. */
      list: (params) => request('GET', `/v1/payouts${query(params)}`),
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
        create: (params, idempotencyKey) => request('POST', '/v1/payouts/batches', params, { idempotencyKey: requireIdempotencyKey(idempotencyKey) }),
        get: (id) => request('GET', `/v1/payouts/batches/${encodeURIComponent(id)}`),
      },
    },
    /** Solo con claves sk_test_: simula que el pagador pagó (el cobro pasa a paid y sale el webhook charge.paid). */
    sandbox: {
      pay: (ref) => request('POST', `/v1/test/charges/${encodeURIComponent(ref)}/pay`),
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
       * `test` es true en el aviso de prueba de «Probar mi webhook» del panel
       * (charge.paid de un cobro que no existe): no entregues nada con él.
       *
       * @returns {{ id: string, event: string, livemode: boolean, test: boolean, data: object }}
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
        return { id: id ?? payload.id, event: payload.event, livemode: payload.livemode, merchant_id: payload.merchant_id ?? null, test: payload.test === true, data: payload.data };
      },

      /**
       * Crea un manejador de webhooks seguro-por-defecto. Verifica firma y
       * frescura (±5 min), descarta duplicados por X-BePago-Event-Id y SOLO
       * invoca `onPaid` con eventos `charge.paid` válidos y no vistos; `onEvent`
       * recibe TODOS los eventos (payout.completed, payout.failed, charge.refunded…).
       * Responde 200 a entregas válidas (también a las duplicadas, para que
       * bePago deje de reintentar) y 400 a firmas/timestamps inválidos.
       *
       * Si `onPaid`/`onEvent` lanzan, responde 500 y el evento NO queda como
       * visto: el reintento de bePago lo vuelve a procesar (que tu entrega sea
       * idempotente por orden). El aviso de prueba del panel («Probar mi
       * webhook», `test: true`) responde 200 sin llamar a tus funciones.
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
          if (body != null && typeof body === 'object' && !(body instanceof Uint8Array)) {
            // El framework ya parseó el JSON: reserializarlo cambia los bytes y la firma no valida.
            return { status: 400, body: JSON.stringify({ error: 'raw_body_required', message: RAW_BODY_HINT }), duplicate: false, ok: false };
          }
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
          if (evt.test) {
            return { status: 200, body: JSON.stringify({ received: true, test: true }), duplicate: false, ok: true, test: true };
          }
          if (await seen.has(evt.id)) {
            return { status: 200, body: JSON.stringify({ received: true, duplicate: true }), duplicate: true, ok: true };
          }
          try {
            if (typeof onEvent === 'function') await onEvent(evt);
            if (evt.event === 'charge.paid' && typeof onPaid === 'function') {
              await onPaid({ reference: evt.data?.reference, data: evt.data, event: evt });
            }
          } catch (err) {
            // Sin marcar como visto: el reintento lo vuelve a procesar.
            return { status: 500, body: JSON.stringify({ error: 'handler_error' }), duplicate: false, ok: false };
          }
          await seen.add(evt.id);
          return { status: 200, body: JSON.stringify({ received: true }), duplicate: false, ok: true };
        }

        return {
          process,
          /** Middleware Express. Montalo con el raw body: app.post(url, express.raw({type:'*&#47;*'}), wh.express()) */
          express() {
            return async (req, res) => {
              const r = await process({ headers: req.headers, body: req.rawBody ?? req.body });
              if (r.status === 400 && r.body.includes('raw_body_required')) console.error(RAW_BODY_HINT);
              res.status(r.status).set('content-type', 'application/json').send(r.body);
            };
          },
          /** Handler Fastify. Registrá un parser que deje el raw body (ver ejemplo en /docs). */
          fastify() {
            return async (req, reply) => {
              const r = await process({ headers: req.headers, body: req.rawBody ?? req.body });
              if (r.status === 400 && r.body.includes('raw_body_required')) req.log?.error?.(RAW_BODY_HINT);
              reply.code(r.status).header('content-type', 'application/json').send(r.body);
            };
          },
        };
      },
    },
  };
  return api;
}

/**
 * Pagos y lotes llevan X-Idempotency-Key OBLIGATORIO (mín. 8 caracteres), igual
 * que la API (400 missing_idempotency_key): se valida acá antes de firmar.
 */
function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || key.trim().length < 8) {
    throw new Error('bePago: falta idempotencyKey (string de al menos 8 caracteres, único por pago o lote)');
  }
  return key;
}

/**
 * ¿Se puede repetir este request sin riesgo? GET: red caída, tiempo agotado o
 * 502/503/504. POST: solo con clave de idempotencia y sin respuesta (red o
 * tiempo): con respuesta, la API ya decidió. Nunca un POST sin clave.
 */
function retryable(err, method, idempotencyKey) {
  if (!(err instanceof BePagoError)) return false;
  const noResponse = err.code === 'network_error' || err.code === 'timeout';
  if (method === 'GET') return noResponse || err.status === 502 || err.status === 503 || err.status === 504;
  return method === 'POST' && Boolean(idempotencyKey) && noResponse;
}

/** Espera antes del reintento N (0, 1…): 250 ms, 500 ms, 1 s… (tope 2 s) más un poco de azar. */
function retryDelayMs(attempt) {
  return Math.min(250 * 2 ** attempt, 2000) + Math.floor(Math.random() * 100);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const RAW_BODY_HINT = 'bePago webhook: llegó el cuerpo ya parseado (objeto) y la firma se calcula sobre los bytes crudos. '
  + "Express: montá la ruta con express.raw({ type: '*/*' }) ANTES de app.use(express.json()). "
  + 'Fastify: registrá la ruta en un plugin propio con un parser que deje el cuerpo como string (ver /docs#webhooks).';

function toRawBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'); // Buffer incluido
  return String(body);
}
