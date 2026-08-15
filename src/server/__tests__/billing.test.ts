import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { MasterDb } from '#/db'
import * as schema from '#/db/schema'
import { nodes, subscriptions } from '#/db/schema'
import { applyBillingEvent } from '../billing'
import { stripeSignatureHeader, verifyEvent } from '../billing/stripe'
import { balances } from '../metering'

/**
 * Selling credits.
 *
 * Two things are worth testing here and nothing else is: that a webhook cannot
 * grant the same credits twice, and that a signature has to be real. Everything
 * else in the billing path is Stripe's problem — but both of these are ours,
 * and both are silent when wrong. Double-granting looks like generosity until
 * somebody adds up a month of it.
 */

const MIGRATIONS = join(import.meta.dir, '../../../drizzle')

function freshDb(): { db: MasterDb; raw: Database } {
  const raw = new Database(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(MIGRATIONS, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      try {
        if (statement.trim()) raw.run(statement.trim())
      } catch {
        /* empty */
      }
    }
  }
  return { db: drizzle(raw, { schema }) as unknown as MasterDb, raw }
}

let db: MasterDb
let raw: Database
let nodeId: number

beforeEach(async () => {
  const made = freshDb()
  db = made.db
  raw = made.raw
  const [node] = await db
    .insert(nodes)
    .values({ slug: 'acme', name: 'Acme', status: 'active' })
    .returning()
  nodeId = node!.id
})

afterEach(() => raw.close())

const session = (id: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${id}`,
  type: 'checkout.session.completed',
  payload: {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 1000,
        currency: 'usd',
        metadata: { nodeId: String(nodeId), packageKey: 'topup-1000', credits: '1000' },
        ...over,
      },
    },
  },
})

const invoice = (id: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${id}`,
  type: 'invoice.paid',
  payload: {
    id: `evt_${id}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_${id}`,
        amount_paid: 6000,
        currency: 'usd',
        subscription_details: {
          metadata: {
            nodeId: String(nodeId),
            packageKey: 'monthly-medium',
            credits: '10000',
          },
        },
        ...over,
      },
    },
  },
})

describe('granting credits', () => {
  test('a paid top-up puts the credits in', async () => {
    const applied = await applyBillingEvent(db, session('a'))
    expect(applied).toMatchObject({ outcome: 'granted', credits: 1000 })
    expect((await balances(db))[0]!.purchased).toBe(1000)
  })

  test('the same event delivered again does nothing', async () => {
    await applyBillingEvent(db, session('a'))
    expect(await applyBillingEvent(db, session('a'))).toMatchObject({
      outcome: 'duplicate',
    })
    expect((await balances(db))[0]!.purchased).toBe(1000)
  })

  test('two events about one session grant once', async () => {
    // Stripe can send more than one event about the same checkout. They are
    // different events — so the event table does not stop them — and they mean
    // the same single purchase. The ledger keys on the session for that reason.
    await applyBillingEvent(db, session('a'))
    await applyBillingEvent(db, { ...session('b'), payload: session('b').payload })
    // Different session ids in this fixture, so both count...
    expect((await balances(db))[0]!.purchased).toBe(2000)

    // ...but the same session under a second event id does not.
    const again = session('c')
    ;(again.payload.data.object as Record<string, unknown>).id = 'cs_a'
    await applyBillingEvent(db, again)
    expect((await balances(db))[0]!.purchased).toBe(2000)
  })

  test('an unpaid session grants nothing', async () => {
    const unpaid = session('d', { payment_status: 'unpaid' })
    expect(await applyBillingEvent(db, unpaid)).toMatchObject({ outcome: 'ignored' })
    expect((await balances(db))[0]!.purchased).toBe(0)
  })

  test("a subscription's own checkout grants nothing", async () => {
    // This is the trap. A subscription's first payment arrives as an invoice
    // *and* as a completed session, under two different ids — so the event
    // table cannot catch it and the ledger key cannot either. Granting on both
    // would put the first month in twice, for every new subscriber, forever.
    const first = session('e', { mode: 'subscription' })
    expect(await applyBillingEvent(db, first)).toMatchObject({ outcome: 'ignored' })
    await applyBillingEvent(db, invoice('f'))
    expect((await balances(db))[0]!.purchased).toBe(10_000)
  })

  test('a renewal grants again; the same invoice does not', async () => {
    await applyBillingEvent(db, invoice('g'))
    await applyBillingEvent(db, invoice('h'))
    expect((await balances(db))[0]!.purchased).toBe(20_000)

    const replay = invoice('i')
    ;(replay.payload.data.object as Record<string, unknown>).id = 'in_g'
    await applyBillingEvent(db, replay)
    expect((await balances(db))[0]!.purchased).toBe(20_000)
  })

  test('an event naming no node is not applied to some other one', async () => {
    const orphan = session('j', { metadata: {} })
    expect(await applyBillingEvent(db, orphan)).toMatchObject({
      outcome: 'unknown-node',
    })
    expect((await balances(db))[0]!.purchased).toBe(0)
  })
})

describe('the subscription itself', () => {
  test('is recorded, and updated in place', async () => {
    const made = {
      id: 'evt_s1',
      type: 'customer.subscription.created',
      payload: {
        id: 'evt_s1',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_1',
            status: 'active',
            customer: 'cus_1',
            current_period_end: 1_800_000_000,
            metadata: { nodeId: String(nodeId), packageKey: 'monthly-medium' },
          },
        },
      },
    }
    await applyBillingEvent(db, made)

    const gone = {
      ...made,
      id: 'evt_s2',
      type: 'customer.subscription.deleted',
      payload: { ...made.payload, id: 'evt_s2', type: 'customer.subscription.deleted' },
    }
    await applyBillingEvent(db, gone)

    const rows = await db.select().from(subscriptions)
    // One row, not two: the same subscription changing state.
    expect(rows.length).toBe(1)
    expect(rows[0]!.status).toBe('canceled')
  })
})

describe('signatures', () => {
  const config = { secretKey: 'sk_test', webhookSecret: 'whsec_test' }
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })

  test('a real signature is accepted', async () => {
    const now = 1_800_000_000
    const header = await stripeSignatureHeader(config.webhookSecret, body, now)
    expect(await verifyEvent(config, body, header, now)).toMatchObject({
      id: 'evt_1',
    })
  })

  test('a forged one is not', async () => {
    const now = 1_800_000_000
    const header = await stripeSignatureHeader('whsec_wrong', body, now)
    expect(await verifyEvent(config, body, header, now)).toBeNull()
  })

  test('an unsigned body is not', async () => {
    expect(await verifyEvent(config, body, null)).toBeNull()
  })

  test('a genuine signature from last year is not', async () => {
    // Replay protection. Without the timestamp check a recording of one real
    // webhook could be sent back at any point in the future and would verify.
    const then = 1_800_000_000
    const header = await stripeSignatureHeader(config.webhookSecret, body, then)
    expect(await verifyEvent(config, body, header, then + 86_400)).toBeNull()
  })

  test('a tampered body is not', async () => {
    const now = 1_800_000_000
    const header = await stripeSignatureHeader(config.webhookSecret, body, now)
    const changed = body.replace('evt_1', 'evt_2')
    expect(await verifyEvent(config, changed, header, now)).toBeNull()
  })
})
