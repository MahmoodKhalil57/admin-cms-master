/**
 * Stripe, for the platform's own billing.
 *
 * Adapted from the node's, and deliberately not shared with it. The node's
 * version is a provider *seam* — an interface with Stripe behind it — because a
 * node's operator chooses their provider and pastes their own keys. Master has
 * exactly one provider, ours, and pretending otherwise would be an abstraction
 * with one implementation that nobody can change.
 *
 * The difference that matters in the code below is subscriptions. The node
 * takes one-off payments; master sells both a top-up and a monthly package, and
 * they are the same Checkout Session with a different `mode`.
 */

const API = 'https://api.stripe.com/v1'
const TOLERANCE_SECONDS = 5 * 60

export interface StripeConfig {
  secretKey: string
  webhookSecret: string
}

async function call(
  config: StripeConfig,
  path: string,
  body: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body,
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const error = (json.error ?? {}) as { message?: string }
    throw new Error(error.message ?? `Stripe refused that (${response.status}).`)
  }
  return json
}

export interface CheckoutInput {
  /** what is being bought */
  packageKey: string
  name: string
  credits: number
  price: number
  currency: string
  monthly: boolean
  /** who is buying — the node the credits land on */
  nodeId: number
  nodeSlug: string
  buyerEmail?: string | null
  successUrl: string
  cancelUrl: string
  /** an existing customer, so a second purchase does not make a second one */
  customerRef?: string | null
}

/**
 * Opens a Checkout Session.
 *
 * `metadata` carries the node and the package on both the session and, for a
 * subscription, the subscription itself — because the events that matter arrive
 * at different times and only some of them can see the session. An invoice for
 * next month's renewal knows nothing about the checkout that started it, so
 * without metadata on the subscription there is no way back to the node.
 */
export async function createCheckout(
  config: StripeConfig,
  input: CheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const body = new URLSearchParams()
  body.set('mode', input.monthly ? 'subscription' : 'payment')
  body.set('success_url', input.successUrl)
  body.set('cancel_url', input.cancelUrl)
  if (input.customerRef) body.set('customer', input.customerRef)
  else if (input.buyerEmail) body.set('customer_email', input.buyerEmail)

  body.set('client_reference_id', `node:${input.nodeId}`)
  body.set('metadata[nodeId]', String(input.nodeId))
  body.set('metadata[packageKey]', input.packageKey)
  body.set('metadata[credits]', String(input.credits))

  body.set('line_items[0][quantity]', '1')
  body.set('line_items[0][price_data][currency]', input.currency.toLowerCase())
  body.set('line_items[0][price_data][unit_amount]', String(input.price))
  body.set('line_items[0][price_data][product_data][name]', input.name)

  if (input.monthly) {
    body.set('line_items[0][price_data][recurring][interval]', 'month')
    // Carried onto every future invoice. Without it a renewal in six months is
    // a payment with nothing on it saying whose it was.
    body.set('subscription_data[metadata][nodeId]', String(input.nodeId))
    body.set('subscription_data[metadata][packageKey]', input.packageKey)
    body.set('subscription_data[metadata][credits]', String(input.credits))
  } else {
    body.set('payment_intent_data[metadata][nodeId]', String(input.nodeId))
    body.set('payment_intent_data[metadata][packageKey]', input.packageKey)
  }

  const session = await call(
    config,
    '/checkout/sessions',
    body,
    // Not keyed on the node alone: somebody may legitimately buy twice. Keyed
    // on the attempt, so a retried *request* reuses a session and a second
    // deliberate purchase opens a new one.
    undefined,
  )
  return { url: String(session.url), sessionId: String(session.id) }
}

/** Ends a subscription at the end of what has been paid for. */
export async function cancelSubscription(
  config: StripeConfig,
  subscriptionRef: string,
): Promise<void> {
  const body = new URLSearchParams()
  // Not immediately: they paid for the month, so they keep the month.
  body.set('cancel_at_period_end', 'true')
  await call(config, `/subscriptions/${subscriptionRef}`, body)
}

/* --- signatures ----------------------------------------------------------- */

function parseSignature(header: string): { t: number; v1: Array<string> } {
  let t = 0
  const v1: Array<string> = []
  for (const part of header.split(',').map((piece) => piece.trim())) {
    const [scheme, value] = part.split('=')
    if (scheme === 't') t = Number(value)
    if (scheme === 'v1' && value) v1.push(value)
  }
  return { t, v1 }
}

/** Constant time, so a wrong signature cannot be found one byte at a time. */
function sameBytes(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Exported for the tests, which have to produce a real signature. */
export async function stripeSignatureHeader(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  return `t=${timestamp},v1=${await sign(secret, `${timestamp}.${body}`)}`
}

export interface VerifiedEvent {
  id: string
  type: string
  payload: Record<string, unknown>
}

/**
 * Checks the signature over the *raw* body.
 *
 * Raw, because re-serialising JSON changes bytes and breaks the signature for
 * reasons nobody enjoys finding at two in the morning. The route reads text and
 * parses afterwards for exactly this reason.
 */
export async function verifyEvent(
  config: StripeConfig,
  body: string,
  signature: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedEvent | null> {
  if (!signature || !config.webhookSecret) return null

  const { t, v1 } = parseSignature(signature)
  if (!t || v1.length === 0) return null
  // Replay protection. Without it a signature stays valid forever, and a
  // recording of one genuine webhook could be sent back at any time.
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return null

  const expected = await sign(config.webhookSecret, `${t}.${body}`)
  if (!v1.some((candidate) => sameBytes(candidate, expected))) return null

  try {
    const event = JSON.parse(body) as Record<string, unknown>
    if (typeof event.id !== 'string' || typeof event.type !== 'string') return null
    return { id: event.id, type: event.type, payload: event }
  } catch {
    return null
  }
}
