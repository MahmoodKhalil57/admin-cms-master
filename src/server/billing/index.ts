import { and, eq } from 'drizzle-orm'

import type { MasterDb } from '#/db'
import {
  billingEvents,
  creditPackages,
  nodes,
  subscriptions,
} from '#/db/schema'
import type { MasterEnv } from '../env'
import { grantCredits } from '../metering'
import type { VerifiedEvent } from './stripe'

/**
 * Selling credits.
 *
 * Feature 7, and the first thing in this roadmap that straddles master and
 * node. Usage happens on the node; the customer relationship, the card and the
 * balance belong here — so the node shows the number and this side owns it.
 *
 * **Every credit granted goes through `grantCredits` with a provider id as its
 * key.** That is the whole idempotency story: a webhook delivered three times
 * posts the same key and the unique index refuses the second and third. There
 * is no "have I applied this" check anywhere below, because a check followed by
 * an action leaves a gap that a concurrent delivery fits into exactly.
 */

export interface Package {
  key: string
  name: string
  description: string | null
  credits: number
  price: number
  currency: string
  monthly: boolean
}

/** Master's own Stripe keys, from the Worker's environment. */
export function stripeConfig(env: MasterEnv) {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) return null
  return { secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '' }
}

/**
 * The three packages, plus a top-up.
 *
 * Seeded rather than hardcoded, so an operator can reprice without a deploy —
 * and re-runnable, because a build that added a package should not need
 * anybody to remember to insert it. Existing rows are never overwritten: a
 * price somebody changed in the console outlives the next deploy.
 */
const STARTER_PACKAGES = [
  {
    key: 'topup-1000',
    name: '1,000 credits',
    description: 'A one-off top-up. No subscription, no expiry.',
    credits: 1000,
    price: 1000,
    monthly: false,
    sortOrder: 0,
  },
  {
    key: 'monthly-small',
    name: 'Small — 2,000 credits a month',
    description: 'For a site that collects enquiries and sells the occasional thing.',
    credits: 2000,
    price: 1500,
    monthly: true,
    sortOrder: 1,
  },
  {
    key: 'monthly-medium',
    name: 'Medium — 10,000 credits a month',
    description: 'A working shop or a busy diary.',
    credits: 10_000,
    price: 6000,
    monthly: true,
    sortOrder: 2,
  },
  {
    key: 'monthly-large',
    name: 'Large — 50,000 credits a month',
    description: 'A marketplace with vendors of its own.',
    credits: 50_000,
    price: 25_000,
    monthly: true,
    sortOrder: 3,
  },
]

export async function ensurePackages(db: MasterDb): Promise<number> {
  const existing = await db.select({ key: creditPackages.key }).from(creditPackages)
  const known = new Set(existing.map((row) => row.key))
  const missing = STARTER_PACKAGES.filter((row) => !known.has(row.key))
  if (missing.length > 0) await db.insert(creditPackages).values(missing)
  return missing.length
}

export async function packagesFor(db: MasterDb): Promise<Array<Package>> {
  await ensurePackages(db)
  const rows = await db
    .select()
    .from(creditPackages)
    .where(eq(creditPackages.active, true))
    .orderBy(creditPackages.sortOrder)
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    credits: row.credits,
    price: row.price,
    currency: row.currency,
    monthly: row.monthly,
  }))
}

export async function packageByKey(
  db: MasterDb,
  key: string,
): Promise<typeof creditPackages.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(creditPackages)
    .where(and(eq(creditPackages.key, key), eq(creditPackages.active, true)))
    .limit(1)
  return row ?? null
}

/** What a node is currently subscribed to, if anything. */
export async function subscriptionFor(
  db: MasterDb,
  nodeId: number,
): Promise<typeof subscriptions.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.nodeId, nodeId), eq(subscriptions.status, 'active')))
    .limit(1)
  return row ?? null
}

export type Applied =
  | { outcome: 'duplicate' }
  | { outcome: 'ignored'; type: string }
  | { outcome: 'unknown-node' }
  | { outcome: 'granted'; nodeId: number; credits: number }
  | { outcome: 'subscription'; nodeId: number; status: string }

/**
 * Records an event and applies it, once.
 *
 * The insert comes first and the unique index decides — the same discipline as
 * the node's order webhook, because this is the same problem. Every event is
 * kept, including the ones that mean nothing here: a billing dispute months
 * from now is answered from this table or not at all.
 */
export async function applyBillingEvent(
  db: MasterDb,
  event: VerifiedEvent,
): Promise<Applied> {
  try {
    await db.insert(billingEvents).values({
      providerEventId: event.id,
      type: event.type,
      payload: event.payload,
    })
  } catch {
    // Seen before. Nothing to do, and nothing to report as a failure either —
    // a retry succeeding quietly is exactly what the provider is hoping for.
    return { outcome: 'duplicate' }
  }

  const applied = await interpret(db, event)
  await db
    .update(billingEvents)
    .set({ result: applied.outcome })
    .where(eq(billingEvents.providerEventId, event.id))
  return applied
}

function objectOf(event: VerifiedEvent): Record<string, unknown> {
  const data = (event.payload.data ?? {}) as Record<string, unknown>
  return (data.object ?? {}) as Record<string, unknown>
}

function metadataOf(object: Record<string, unknown>): Record<string, string> {
  return (object.metadata ?? {}) as Record<string, string>
}

async function interpret(db: MasterDb, event: VerifiedEvent): Promise<Applied> {
  const object = objectOf(event)

  /*
    A one-off top-up.

    Only the `payment` mode is granted here. A subscription's first payment
    arrives as an invoice too, and granting on both would put the first month's
    credits in twice — under two different keys, so the index would not save
    us. This is the one place in the file where the idempotency guarantee is
    not automatic, which is why the mode is checked rather than assumed.
  */
  if (event.type === 'checkout.session.completed') {
    if (String(object.mode) === 'subscription') {
      return { outcome: 'ignored', type: 'subscription checkout' }
    }
    if (object.payment_status !== 'paid') {
      return { outcome: 'ignored', type: 'unpaid session' }
    }
    const meta = metadataOf(object)
    const nodeId = Number(meta.nodeId)
    const credits = Number(meta.credits)
    if (!nodeId || !credits) return { outcome: 'unknown-node' }

    await grantCredits(db, {
      nodeId,
      kind: 'purchase',
      credits,
      amount: Number(object.amount_total ?? 0),
      currency: String(object.currency ?? 'usd').toUpperCase(),
      note: `Bought ${meta.packageKey ?? 'credits'}`,
      // The session, not the event: Stripe can send more than one event about
      // one session, and all of them mean the same single purchase.
      dedupeKey: `session:${String(object.id)}`,
    })
    return { outcome: 'granted', nodeId, credits }
  }

  /*
    A month of a subscription, including its first.

    Every renewal is an invoice, so this is the one handler that runs every
    month for as long as somebody stays — and the invoice id is what keeps a
    retried delivery from granting twice.
  */
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const meta = metadataOf(
      (object.subscription_details as Record<string, unknown>) ?? {},
    )
    const fromLines = subscriptionMetadata(object)
    const nodeId = Number(meta.nodeId || fromLines.nodeId)
    const credits = Number(meta.credits || fromLines.credits)
    if (!nodeId || !credits) return { outcome: 'unknown-node' }

    await grantCredits(db, {
      nodeId,
      kind: 'purchase',
      credits,
      amount: Number(object.amount_paid ?? 0),
      currency: String(object.currency ?? 'usd').toUpperCase(),
      note: `Monthly ${meta.packageKey || fromLines.packageKey || 'package'}`,
      dedupeKey: `invoice:${String(object.id)}`,
    })
    return { outcome: 'granted', nodeId, credits }
  }

  // The relationship, separately from the money. Status is the provider's word.
  if (event.type.startsWith('customer.subscription.')) {
    const meta = metadataOf(object)
    const nodeId = Number(meta.nodeId)
    if (!nodeId) return { outcome: 'unknown-node' }

    const status =
      event.type === 'customer.subscription.deleted'
        ? 'canceled'
        : String(object.status ?? 'active')

    const periodEnd = Number(object.current_period_end ?? 0)
    const values = {
      nodeId,
      packageKey: String(meta.packageKey ?? ''),
      providerRef: String(object.id),
      customerRef: object.customer ? String(object.customer) : null,
      status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    }

    await db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.providerRef,
        set: {
          status: values.status,
          currentPeriodEnd: values.currentPeriodEnd,
          customerRef: values.customerRef,
        },
      })
    return { outcome: 'subscription', nodeId, status }
  }

  return { outcome: 'ignored', type: event.type }
}

/**
 * An invoice's metadata, when Stripe puts it on the line rather than the top.
 *
 * Older API versions and some invoice shapes carry the subscription's metadata
 * only on the line item. Reading both is cheaper than being wrong about which
 * one this account's version sends.
 */
function subscriptionMetadata(object: Record<string, unknown>): Record<string, string> {
  const lines = (object.lines ?? {}) as { data?: Array<Record<string, unknown>> }
  for (const line of lines.data ?? []) {
    const meta = metadataOf(line)
    if (meta.nodeId) return meta
  }
  return {}
}

/** The node a slug names, for the internal route the node itself calls. */
export async function nodeBySlug(db: MasterDb, slug: string) {
  const [row] = await db.select().from(nodes).where(eq(nodes.slug, slug)).limit(1)
  return row ?? null
}
