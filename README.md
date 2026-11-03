# bePago — SDK para Node.js

SDK oficial de [bePago](https://bepago.com) para Node.js 18+. Sin dependencias.

Cobros con checkout embebido, pagos masivos (payouts) y webhooks firmados
(HMAC v2). Es el mismo SDK de la [guía de integración](https://bepago.com/docs):
cada ejemplo de acá funciona copiado tal cual.

## Instalación

```bash
npm install bepago
```

## Uso

```js
import BePago from 'bepago';

const bp = BePago(process.env.BEPAGO_SECRET); // sk_test_… o sk_live_…: la clave decide el modo
```

La clave (`sk_…`) la creás en tu panel (Integraciones › Claves de API). El key
ID público (`pk_…`) se deriva solo; si necesitás pasarlo aparte:
`BePago(secret, { keyId: 'pk_…' })`.

## Cobros

### 1. Crear el cobro (en tu backend)

```js
const cobro = await bp.charges.create({
  reference: 'pedido-1842',   // tu orden: misma referencia = mismo cobro
  currency: 'PYG',
  amount: 150000,             // guaraníes, sin decimales; el monto sale de tu servidor
  description: 'Pedido 1842',
  // method: 'qr_sip',        // opcional: qr_sip | pix | qr_ar (ver abajo)
});

cobro.checkout_url; // lo que embebés en tu página
```

- **Monto mínimo:** lo fija el medio de pago (QR SIP: Gs 1.000) y, si lo
  configuraste, el mínimo propio de tu comercio. Debajo, `422
  charge_amount_invalid` (límites del medio) o `422 charge_below_minimum` (tu
  mínimo; `details.minimum` dice cuánto).
- **`method` (opcional):** fuerza el método de este cobro. Tiene que estar
  activo en tu panel (Integraciones › Métodos de cobro); si no,
  `422 collect_method_not_enabled` con los activos en `details.enabled_methods`.
  Con un método forzado (o si tenés uno solo activo), el checkout va directo al
  QR, sin selector. Sin `method`, el pagador elige entre tus métodos activos.

Consultar, reembolsar y ver saldo:

```js
await bp.charges.get('pedido-1842');
await bp.charges.refund('pedido-1842', 'cliente canceló');
await bp.charges.balance();
```

### 2. Embeber el checkout en tu página (iframe, `bepago.js`)

El checkout se monta en un iframe **dentro** de tu `div`, sin redirigir ni abrir
otra ventana. Es compacto y sin estilo propio (fondo transparente, sin bordes,
máx. 320 px centrado): el monto en una línea chica, el QR (220 px en
escritorio, 180 px en celular) y debajo
“Esperando pago · vence en 4:50 · **Descargar QR**”. *Descargar QR* baja el QR
como PNG (`bepago-qr-<referencia>.png`, fondo blanco) para abrirlo desde la app
del banco; en celular, si el navegador lo permite, abre compartir/guardar
imagen. El iframe toma el alto de su contenido.

```html
<div id="bepago-checkout"></div>
<script src="https://bepago.com/sdk/bepago.js"></script>
<script>
  BePago.checkout({
    url: checkoutUrl,           // la checkout_url que devolvió TU backend
    mount: '#bepago-checkout',
    theme: 'light',             // 'dark' si tu página tiene fondo oscuro
    showAmount: true,           // false si ya mostrás el monto en tu página
    onPaid: ({ reference }) => {
      // SOLO UI: mostrá "¡Gracias!" o redirigí. La confirmación es de tu backend.
      location.href = '/gracias/' + reference;
    },
  });
</script>
```

`onPaid` llega cuando el checkout avisa `{ type: 'bepago:paid', reference }`
(postMessage, solo a los dominios que registraste en Integraciones › Dominio del
checkout). Corre en el navegador del comprador y se puede falsificar: **nunca
entregues desde ahí**. `onComplete` sigue existiendo (fin del checkout, en
cualquier estado).

### 3. Recibir el webhook y entregar (en tu backend)

El handler verifica firma y frescura (±5 min), descarta duplicados por
`x-bepago-event-id`, responde 200 y **solo** invoca `onPaid` con eventos
válidos. Antes de entregar, reconfirmá por API con `charges.confirm` y compará
el monto contra tu orden.

```js
// El handler necesita el cuerpo CRUDO: montá express.raw ANTES del parser JSON.
const webhook = bp.webhooks.handler({
  secret: process.env.BEPAGO_WEBHOOK_SECRET,
  // store: en producción, respaldalo en tu base (tabla de event ids) para no
  // entregar dos veces tras un reinicio. Por defecto es un Set en memoria.
  onPaid: async ({ reference }) => {
    const order = await db.orders.find(reference);
    const { paid, charge } = await bp.charges.confirm(reference);   // fuente de verdad
    if (paid && order && charge.amount === order.amount) await entregar(order);
  },
});

app.post('/webhooks/bepago', express.raw({ type: '*/*' }), webhook.express());
```

Fastify:

```js
fastify.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => done(null, body));
fastify.post('/webhooks/bepago', webhook.fastify());
```

Verificación a mano (si no usás el handler):

```js
const evt = bp.webhooks.verify(process.env.BEPAGO_WEBHOOK_SECRET, {
  id: req.headers['x-bepago-event-id'],
  timestamp: req.headers['x-webhook-timestamp'],
  signature: req.headers['x-webhook-signature'],
  body: rawBody, // el cuerpo tal cual llegó, sin re-serializar
}); // lanza si la firma no valida o el timestamp está fuera de ±5 min
// (configurable: bp.webhooks.verify(secret, {...}, { toleranceSeconds: 600 }))
```

## Pagos masivos (payouts)

La **clave de idempotencia es obligatoria** en pagos y en lotes (mín. 8
caracteres, única por pago o lote), igual que en la API: el SDK la exige antes
de mandar el pedido. Repetir el mismo pedido con la misma clave devuelve el
mismo pago, sin crear otro.

```js
const payout = await bp.payouts.create({
  amount: 1500000, currency: 'PYG',
  destination: { type: 'alias', alias: '0981600123' },
  description: 'Quincena',
}, 'idem-key-unica-por-pago');

await bp.payouts.get(payout.id);
await bp.payouts.cancel(payout.id);
await bp.payouts.balance();
```

- **Monto mínimo por pago:** lo fija bePago (hoy Gs 1.000). Uno menor se rechaza
  con `422 amount_below_minimum` y el mensaje dice el mínimo vigente; en un lote
  se rechaza esa fila y las demás siguen.

Lote (hasta 1000 pagos; queda pendiente de aprobación en el panel, cuatro ojos,
salvo auto-aprobación por API habilitada):

```js
const lote = await bp.payouts.batches.create({
  payouts: [{ amount: 500000, destination: { type: 'alias', alias: '0981600123' }, external_id: 'nom-oct-001' }],
}, 'idem-key-unica-por-lote');
await bp.payouts.batches.get(lote.id);
```

## Documentación

Guía completa, referencia de la API, eventos y errores:
**https://bepago.com/docs**

## Licencia

MIT
