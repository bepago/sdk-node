# Cambios — bePago SDK para Node.js

## 1.6.3 — 2026-11-03

- `sandbox.fund` acepta también el cuerpo de la API: `fund({ amount: 5000000 })` (además de `fund(5000000)` y `fund()`). Antes un objeto llegaba como `amount` y la API respondía 400.

## 1.6.2 — 2026-11-03

- `sandbox.fund(amount?)`: carga saldo de prueba para pagos masivos (`POST /v1/test/balance/fund`, solo `sk_test_`).
- Tipos de pagos y lotes como los devuelve la API (`destination` en snake_case, `batch_number`, filas con `id: null` mientras el lote espera aprobación).

## 1.6.1 — 2026-11-03

- El evento de `webhooks.verify` / `onEvent` trae `merchant_id` (tu ID de comercio), como el cuerpo real del aviso.

## 1.6.0 — 2026-11-03

- **Reintentos automáticos** (`maxRetries`, 2 por defecto; `0` los apaga): las
  consultas (GET) ante red caída, tiempo agotado o `502`/`503`/`504`; los pagos
  y lotes (POST con clave de idempotencia) solo ante red caída o tiempo
  agotado, con la misma clave. Un POST sin clave nunca se reintenta. Cada
  intento se firma de nuevo.
- **Tipos TypeScript** en el paquete (`index.d.ts` para `import`, `index.d.cts`
  para `require`).
- **CommonJS:** `const BePago = require('bepago')` en Node 18+, con la misma API
  que `import` (`index.cjs`, generado de `index.mjs`).
- `webhooks.handler` acepta el cuerpo crudo también como `Uint8Array`.

## 1.5.0 — 2026-11-03

- El Key ID (`pk_…`) sale del secreto: `BePago(secret)` alcanza con las claves
  nuevas; con las de un formato anterior, error claro que pide `{ keyId }`.
- Errores tipados: `BePagoError` con `status` (0 sin respuesta), `code`,
  `requestId`, `details` y `response`; `network_error`, `timeout` e
  `invalid_response` cuando no hay respuesta JSON de la API.
- Opción `timeoutMs`; `baseUrl` acepta la dirección con `/v1` al final.
- Nuevos: `charges.list`, `charges.cancel`, `payouts.list` (paginados por
  cursor) y `sandbox.pay` (simula el pago con claves de prueba).
- `webhooks.handler`: el aviso de prueba del panel (`test: true`) responde 200
  sin llamar a tus funciones; `verify` expone `test`.

## 1.4.0 — 2026-11-03

- La clave de idempotencia es obligatoria en `payouts.create` y
  `payouts.batches.create` (mín. 8 caracteres), igual que la API: el SDK la
  exige antes de firmar.
- Cobros con `method` (`qr_sip`, `pix`, `qr_ar`) para forzar el medio; README
  alineado con la guía y con el checkout embebido (`bepago.js`).

## 1.3.0 — 2026-10-26

- Lotes de pagos masivos: `payouts.batches.create` y `payouts.batches.get`.

## 1.2.0 — 2026-10-25

- `charges.confirm(ref)`: confirma el estado real de un cobro contra la API
  (`paid` con `paid` o `settled`).
- `webhooks.handler`: verifica firma y frescura, descarta duplicados por id de
  evento, invoca `onPaid`/`onEvent` y responde 500 si tu función lanza (el
  reintento lo vuelve a procesar). Adapters `express()` y `fastify()`.

## 1.1.0 — 2026-10-23

- `webhooks.verify` rechaza timestamps fuera de ±5 minutos (configurable con
  `toleranceSeconds`) y devuelve el `id` del evento para deduplicar.

## 1.0.0 — 2026-10-23

- Primera versión estable: cobros, pagos masivos y verificación de webhooks
  con firma HMAC v2.
