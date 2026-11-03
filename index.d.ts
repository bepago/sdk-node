/**
 * Tipos del SDK de bePago para Node.js (index.mjs / index.cjs). Los montos son
 * enteros en guaraníes (PYG). index.d.cts (para `require`) se genera de este
 * archivo con scripts/sdk/build-cjs.mjs: se edita solo este.
 */

/** Medios de cobro que se pueden forzar en un cobro. */
export type CollectMethod = 'qr_sip' | 'pix' | 'qr_ar';
export type ChargeStatus = 'created' | 'pending' | 'paid' | 'settled' | 'expired' | 'refunded' | 'failed';
export type PayoutStatus = 'created' | 'validating' | 'ready' | 'held' | 'submitting' | 'submitted' | 'unknown' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'expired';
export type BatchStatus = 'pending_approval' | 'processing' | 'completed' | 'completed_with_errors' | 'cancelled';

export interface BePagoOptions {
  /** Key ID público (pk_…). Solo con secretos de un formato anterior, que no lo traen adentro. */
  keyId?: string;
  /** Default 'https://bepago.com/api' (acepta también la dirección con /v1 al final). */
  baseUrl?: string;
  /** Tiempo máximo de cada intento, en milisegundos. Default 30000. */
  timeoutMs?: number;
  /**
   * Reintentos automáticos (default 2; 0 los apaga). Solo donde repetir no
   * duplica nada: GET ante red caída, tiempo agotado o 502/503/504; POST con
   * clave de idempotencia (pagos y lotes) ante red caída o tiempo agotado.
   */
  maxRetries?: number;
}

export interface Customer {
  name?: string;
  email?: string;
  document?: string;
  phone?: string;
}

export interface CreateChargeParams {
  /** Tu referencia única: misma referencia = mismo cobro. */
  reference: string;
  currency: 'PYG';
  amount: number;
  description: string;
  /** Segundos de vida del checkout (60–604800, default 1800). */
  expires_in?: number;
  return_url?: string;
  method?: CollectMethod;
  customer?: Customer;
  metadata?: Record<string, unknown>;
}

export interface Charge {
  id: string;
  reference: string;
  status: ChargeStatus;
  livemode: boolean;
  checkout_url: string;
  currency: 'PYG';
  amount: number;
  fee: number;
  net: number;
  expected_net: number;
  description: string;
  method: CollectMethod | null;
  requested_method: CollectMethod | null;
  customer: { name: string | null; email: string | null; phone: string | null; document_last4: string | null };
  return_url: string | null;
  expires_at: string;
  paid_at: string | null;
  operation_number: string | null;
  failure_code: string | null;
  created_at: string;
  [extra: string]: unknown;
}

export interface ListParams<S extends string = string> {
  /** 1 a 100, default 20. */
  limit?: number;
  status?: S;
  /** ISO 8601 o YYYY-MM-DD, sobre created_at. */
  from?: string;
  to?: string;
  /** El next_cursor de la página anterior. */
  cursor?: string;
}

export interface ListPage<T> {
  object: 'list';
  livemode: boolean;
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ChargesBalance {
  livemode: boolean;
  balances: Array<{ currency: 'PYG'; available: number; fees_payable: number }>;
}

export interface ConfirmResult {
  /** true si el cobro figura paid o settled. */
  paid: boolean;
  status: ChargeStatus;
  charge: Charge;
}

export type PayoutDestination =
  | { type: 'alias'; alias: string }
  | { type: 'bank_account'; bank_code: string; account_number: string; document: string; holder_name: string };

export interface CreatePayoutParams {
  amount: number;
  currency: 'PYG';
  destination: PayoutDestination;
  description?: string;
  external_id?: string;
  prize_ref?: string;
  metadata?: Record<string, unknown>;
  /** https:// */
  callback_url?: string;
}

export interface Payout {
  id: string;
  status: PayoutStatus;
  livemode: boolean;
  amount: number;
  fee: number;
  net: number;
  currency: 'PYG';
  external_id: string | null;
  prize_ref: string | null;
  hold_reason: string | null;
  failure_code: string | null;
  operation_number: string | null;
  beneficiary_name: string | null;
  destination: { type: 'alias'; alias: string } | { type: 'bank_account'; [field: string]: unknown };
  created_at: string;
  [extra: string]: unknown;
}

export interface PayoutsBalance {
  available: number;
  reserved: number;
  fees_payable: number;
  currency: 'PYG';
  livemode: boolean;
}

export interface CreateBatchParams {
  filename?: string;
  /** Hasta 1000 pagos (en guaraníes; sin currency ni metadata por fila). */
  payouts: Array<Pick<CreatePayoutParams, 'amount' | 'destination' | 'description' | 'external_id' | 'prize_ref'>>;
}

export interface BatchRow {
  row: number;
  id: string;
  status: PayoutStatus;
  amount: number;
  fee: number;
  net: number;
  reference: string | null;
  operation_number: string | null;
  failure_code: string | null;
  beneficiary_name: string | null;
}

export interface Batch {
  id: string;
  status: BatchStatus;
  livemode: boolean;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  total_amount: number;
  total_fee: number;
  currency: 'PYG';
  invalid: Array<{ row: number; reason: string; [extra: string]: unknown }>;
  payouts: BatchRow[];
  [extra: string]: unknown;
}

/** Un aviso de webhook ya verificado. */
export interface WebhookEvent<D = Record<string, unknown>> {
  /** X-BePago-Event-Id: estable entre reintentos (deduplicá por él). */
  id: string;
  event: string;
  livemode: boolean;
  /** Tu ID de comercio (el del panel), como string con dígitos. */
  merchant_id: string | null;
  /** true en el aviso de prueba de «Probar mi webhook» (no entregues nada). */
  test: boolean;
  data: D;
}

export interface WebhookInput {
  id?: string;
  timestamp: string | number;
  body: string;
  signature: string;
}

export interface VerifyOptions {
  /** Ventana de frescura del timestamp, en segundos. Default 300 (±5 min). */
  toleranceSeconds?: number;
}

/** Ids de eventos ya procesados. Por defecto un Set en memoria; en producción, respaldalo en tu base. */
export interface SeenStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

export interface WebhookHandlerConfig extends VerifyOptions {
  secret: string;
  /** Solo con charge.paid válidos y no vistos. */
  onPaid?: (ctx: { reference: string | undefined; data: Record<string, unknown>; event: WebhookEvent }) => unknown | Promise<unknown>;
  /** Todos los eventos (payout.completed, payout.failed, charge.refunded…). */
  onEvent?: (evt: WebhookEvent) => unknown | Promise<unknown>;
  store?: SeenStore;
}

export interface WebhookProcessInput {
  headers?: Record<string, string | string[] | undefined>;
  /** El cuerpo CRUDO, tal cual llegó. Un objeto ya parseado responde 400 raw_body_required. */
  body: string | Uint8Array | null | undefined;
}

export interface WebhookProcessResult {
  /** 200 (válido, duplicado o de prueba), 400 (firma, timestamp o cuerpo) o 500 (tu función lanzó). */
  status: 200 | 400 | 500;
  /** JSON listo para responder. */
  body: string;
  duplicate: boolean;
  ok: boolean;
  test?: true;
}

export interface WebhookHandler {
  process(input: WebhookProcessInput): Promise<WebhookProcessResult>;
  /** Middleware Express: app.post(url, express.raw({ type: '*\/*' }), wh.express()). */
  express(): (req: any, res: any) => Promise<void>;
  /** Handler Fastify (con un parser que deje el cuerpo como string). */
  fastify(): (req: any, reply: any) => Promise<void>;
}

export interface BePagoClient {
  charges: {
    create(params: CreateChargeParams): Promise<Charge>;
    get(ref: string): Promise<Charge>;
    list(params?: ListParams<ChargeStatus>): Promise<ListPage<Charge>>;
    cancel(ref: string): Promise<Charge>;
    /** Reembolso por el total del cobro; `reason` obligatorio (3 a 200 caracteres). */
    refund(ref: string, reason: string): Promise<Charge>;
    balance(): Promise<ChargesBalance>;
    confirm(ref: string): Promise<ConfirmResult>;
  };
  payouts: {
    /** `idempotencyKey` obligatorio (mín. 8 caracteres): la misma clave = el mismo pago. */
    create(params: CreatePayoutParams, idempotencyKey: string): Promise<Payout>;
    get(id: string): Promise<Payout>;
    list(params?: ListParams<PayoutStatus>): Promise<ListPage<Payout>>;
    cancel(id: string): Promise<Payout>;
    balance(): Promise<PayoutsBalance>;
    batches: {
      create(params: CreateBatchParams, idempotencyKey: string): Promise<Batch>;
      get(id: string): Promise<Batch>;
    };
  };
  /** Solo con claves sk_test_. */
  sandbox: {
    pay(ref: string): Promise<Charge>;
  };
  webhooks: {
    /** Lanza si la firma no valida o el timestamp está fuera de la ventana. */
    verify(webhookSecret: string, input: WebhookInput, opts?: VerifyOptions): WebhookEvent;
    handler(config: WebhookHandlerConfig): WebhookHandler;
  };
}

/** Error de la API o de la conexión. */
export declare class BePagoError extends Error {
  constructor(message: string, init?: { status?: number; code?: string | null; requestId?: string | null; details?: unknown; response?: unknown });
  name: 'BePagoError';
  /** HTTP; 0 si no hubo respuesta. */
  status: number;
  /** Código de bePago (insufficient_funds…) o network_error, timeout, invalid_response, missing_key_id. */
  code: string | null;
  requestId: string | null;
  details: unknown;
  response: unknown;
}

export interface SignatureInput {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  /** Path de la API con su query (/v1/…), sin el prefijo /api. */
  path: string;
  idempotencyKey?: string | null;
  /** El cuerpo YA serializado; cadena vacía sin body. */
  body?: string;
}

/** Firma canónica v2 de un request (hex). */
export declare function computeSignatureV2(input: SignatureInput): string;

/** Key ID público (pk_…) de un secreto; null con los secretos de un formato anterior. */
export declare function keyIdFromSecret(secret: string): string | null;

/** Crea un cliente. `secret` es sk_test_… o sk_live_…: la clave decide el modo. */
declare function BePago(secret: string, opts?: BePagoOptions): BePagoClient;
export default BePago;
