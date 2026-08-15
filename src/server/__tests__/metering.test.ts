import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { MasterDb } from '#/db'
import * as schema from '#/db/schema'
import { nodes } from '#/db/schema'
import { balances, grantCredits, storeUsage, usageFor } from '../metering'

/**
 * Master's half of the meter.
 *
 * One claim under test, and everything else follows from it: **storing a period
 * replaces it rather than adding to it.** The node's counted usage is derived
 * from its own event log, so a retry recomputes the same figures — which makes
 * replacing free and adding a double bill. That is why nothing in this pipeline
 * carries an idempotency key, and it is worth a test saying so out loud,
 * because the version that appends looks identical until the first retry.
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

const APRIL = {
  period: '2026-04',
  priceListVersion: 1,
  lines: [
    { item: 'submission', quantity: 10, credits: 10 },
    { item: 'order', quantity: 3, credits: 15 },
    { item: 'egress', quantity: 0, credits: 0, pending: true },
  ],
}

let db: MasterDb
let raw: Database

beforeEach(async () => {
  const made = freshDb()
  db = made.db
  raw = made.raw
  await db.insert(nodes).values({ slug: 'acme', name: 'Acme', status: 'active' })
})

afterEach(() => raw.close())

describe('storing a reading', () => {
  test('a period is stored once, with its lines', async () => {
    const stored = await storeUsage(db, 'acme', APRIL)
    expect(stored).toMatchObject({ stored: 3, credits: 25 })

    const periods = await usageFor(db, stored!.nodeId)
    expect(periods.length).toBe(1)
    expect(periods[0]!.credits).toBe(25)
  })

  test('reporting the same period twice does not double the bill', async () => {
    await storeUsage(db, 'acme', APRIL)
    await storeUsage(db, 'acme', APRIL)
    await storeUsage(db, 'acme', APRIL)

    const [balance] = await balances(db)
    // Three deliveries, one bill. If this ever reads 75 the store has started
    // adding, and every retried report has been charged for.
    expect(balance!.used).toBe(25)
  })

  test('a corrected reading replaces the earlier one', async () => {
    await storeUsage(db, 'acme', APRIL)
    await storeUsage(db, 'acme', {
      ...APRIL,
      lines: [{ item: 'submission', quantity: 4, credits: 4 }],
    })

    const [balance] = await balances(db)
    // Not 25 + 4, and not 25. The last word on April is April's figure — which
    // is what makes a late correction possible at all.
    expect(balance!.used).toBe(4)
  })

  test('two periods accumulate; one period does not', async () => {
    await storeUsage(db, 'acme', APRIL)
    await storeUsage(db, 'acme', { ...APRIL, period: '2026-05' })
    const [balance] = await balances(db)
    expect(balance!.used).toBe(50)
    expect((await usageFor(db, balance!.nodeId)).length).toBe(2)
  })

  test('an item this build does not price is dropped, not stored', async () => {
    // Master takes the node's word for the credits, so an item it cannot look
    // up would be a charge nobody can audit.
    const stored = await storeUsage(db, 'acme', {
      ...APRIL,
      lines: [{ item: 'moon-dust', quantity: 99, credits: 9999 }],
    })
    expect(stored).toMatchObject({ stored: 0, credits: 0 })
  })

  test('a node that does not exist is refused', async () => {
    expect(await storeUsage(db, 'nobody', APRIL)).toBeNull()
  })
})

describe('the balance', () => {
  test('is credits in minus what the meter says came out', async () => {
    const stored = await storeUsage(db, 'acme', APRIL)
    await grantCredits(db, {
      nodeId: stored!.nodeId,
      kind: 'grant',
      credits: 100,
    })
    const [balance] = await balances(db)
    expect(balance).toMatchObject({ purchased: 100, used: 25, balance: 75 })
  })

  test('is allowed below zero', async () => {
    // Metering must never be the thing that breaks somebody's shop, so a node
    // that has used more than it bought keeps working and owes the difference.
    await storeUsage(db, 'acme', APRIL)
    const [balance] = await balances(db)
    expect(balance!.balance).toBe(-25)
  })

  test('credits granted twice under one key are granted once', async () => {
    const stored = await storeUsage(db, 'acme', APRIL)
    const first = await grantCredits(db, {
      nodeId: stored!.nodeId,
      kind: 'purchase',
      credits: 500,
      dedupeKey: 'pi_abc123',
    })
    const second = await grantCredits(db, {
      nodeId: stored!.nodeId,
      kind: 'purchase',
      credits: 500,
      dedupeKey: 'pi_abc123',
    })
    expect(first).toBe(true)
    // The index refused it, which is the guarantee — not a check beforehand.
    expect(second).toBe(false)
    expect((await balances(db))[0]!.purchased).toBe(500)
  })
})
