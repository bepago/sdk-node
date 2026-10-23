# bePago — SDK para Node.js

SDK oficial de [bePago](https://bepago.com) para Node.js 18+. Sin dependencias.

Cobros, pagos masivos (payouts) y verificación de webhooks con firma HMAC v2.

## Instalación

```bash
npm install bepago
```

## Uso

```js
import BePago from 'bepago';

const bp = BePago('sk_live_tu_secreto');
```

La clave (`sk_…`) la obtenés en tu panel de bePago. El key ID público (`pk_…`)
se deriva solo; si necesitás pasarlo aparte: `BePago(secret, { keyId: 'pk_…' })`.

### Crear un cobro

```js
const cobro = await bp.charges.create({
  reference: 'pedido-001',
  currency: 'PYG',
  amount: 150000,
  description: 'Pedido #001',
});

console.log(cobro.checkout_url); // link de pago para el cliente
```

Consultar, reembolsar y ver saldo:

```js
await bp.charges.get('pedido-001');
await bp.charges.refund('pedido-001', 'cliente canceló');
await bp.charges.balance();
```

### Pago masivo (payout)

```js
const payout = await bp.payouts.create(
  {
    currency: 'PYG',
    amount: 500000,
    destination: { alias: 'juan.perez', holder_name: 'Juan Pérez' },
  },
  'idem-key-unica', // clave de idempotencia (opcional pero recomendada)
);

await bp.payouts.get(payout.id);
await bp.payouts.cancel(payout.id);
await bp.payouts.balance();
```

### Verificar un webhook

bePago firma cada webhook con `HMAC-SHA256` sobre `timestamp + body` usando el
secreto del webhook. Verificá la firma antes de procesar el evento:

```js
import BePago from 'bepago';

const bp = BePago('sk_live_…');

// En tu handler HTTP (body como string crudo, sin re-serializar):
const timestamp = req.headers['x-timestamp'];
const signature = req.headers['x-signature'];
const rawBody = req.rawBody; // el cuerpo tal cual llegó

const ok = bp.webhooks.verify(
  'whsec_tu_secreto_de_webhook',
  timestamp,
  rawBody,
  signature,
);

if (!ok) {
  return res.status(400).send('firma inválida');
}

const evento = JSON.parse(rawBody);
// procesar evento.type …
```

## Documentación

Referencia completa de la API, tipos de eventos y ejemplos:
**https://bepago.com/docs**

## Licencia

MIT
