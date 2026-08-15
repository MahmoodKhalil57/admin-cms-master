import { and, eq, inArray, notInArray, sql, sum } from 'drizzle-orm'

import { getDb } from '#/db'
import type { MasterDb } from '#/db'
import { creditLedger, nodeMeters, nodes } from '#/db/schema'
import type { MasterEnv } from './env'
import { PRICE_LIST, meterItem } from '#/lib/price-list'

/**
 * What nodes have used, and what they have paid for.
 *
 * Master's half of the meter. The node counts and reports; this stores, prices
 * nothing again, and answers "what is the balance".
 *
 * **A balance is arithmetic over two tables, not a column.** Credits in come
 * from an append-only ledger; credits out are the sum of the meter rows. Nothing
 * writes a balance down, so nothing can write down a wrong one — the same
 * reasoning as the vendor ledger a level below, for the same reason.
 */

export interface ReportedLine {
  item: string
  quantity: number
  credits: number
  pending?: boolean
}

export interface UsageReport {
  period: string
  priceListVersion: number
  lines: Array<ReportedLine>
}

/**
 * Stores a reading, replacing whatever was there for that period.
 *
 * Replace rather than add, and it is worth being explicit about why that is
 * safe here and would not be for most usage pipelines. The node's counted usage
 * is *derived* from its event log rather than accumulated as it happens, so
 * reporting April twice produces April's number twice — not April's number
 * doubled. Replacing therefore makes a retry free, and it also makes a late
 * correction possible, which an append-only meter cannot do without a
 * compensating row somebody has to reason about.
 *
 * The exception is measured usage, which is a sample and cannot be recomputed.
 * A later reading of storage replaces an earlier one, which is the right
 * behaviour — the most recent sample is the best answer available — and it does
 * mean a period's storage figure is "what it was when last looked at" rather
 * than an average. Said plainly because it is the one number here that is an
 * estimate.
 */
export async function storeUsage(
  db: MasterDb,
  slug: string,
  report: UsageReport,
): Promise<{ stored: number; credits: number; nodeId: number } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.slug, slug)).limit(1)
  if (!node) return null

  let credits = 0
  let stored = 0
  /** which items this reading actually spoke about */
  const seen: Array<string> = []

  for (const line of report.lines) {
    // A line naming an item this build does not know about is dropped rather
    // than stored. Master prices nothing — it takes the node's word for the
    // credits — so an unknown item would be an unauditable charge.
    if (!meterItem(line.item)) continue

    const values = {
      nodeId: node.id,
      period: report.period,
      item: line.item,
      quantity: Math.max(Math.trunc(line.quantity) || 0, 0),
      credits: Math.max(Math.trunc(line.credits) || 0, 0),
      priceListVersion: report.priceListVersion,
      pending: Boolean(line.pending),
      reportedAt: new Date(),
    }

    await db
      .insert(nodeMeters)
      .values(values)
      .onConflictDoUpdate({
        target: [nodeMeters.nodeId, nodeMeters.period, nodeMeters.item],
        set: {
          quantity: values.quantity,
          credits: values.credits,
          priceListVersion: values.priceListVersion,
          pending: values.pending,
          reportedAt: values.reportedAt,
        },
      })

    credits += values.credits
    stored += 1
    seen.push(line.item)
  }

  /*
    Anything the period used to have and no longer does.

    Upserting each incoming line is only half of "replace the period" — it
    leaves behind rows for items the new reading did not mention, and those
    keep being counted forever. It bites when the price list loses an item or
    renames one, and the symptom is a customer billed every month for something
    nothing reports any more.

    A reading is a complete statement about a period, so the absence of a line
    is information: it means zero, and zero means no row.
  */
  await db
    .delete(nodeMeters)
    .where(
      and(
        eq(nodeMeters.nodeId, node.id),
        eq(nodeMeters.period, report.period),
        seen.length > 0 ? notInArray(nodeMeters.item, seen) : undefined,
      ),
    )

  return { stored, credits, nodeId: node.id }
}

export interface NodeBalance {
  nodeId: number
  slug: string
  /** everything ever put in */
  purchased: number
  /** everything the meter says came out */
  used: number
  /** the difference, which may be below zero */
  balance: number
}

/**
 * What every node stands at.
 *
 * One query per side rather than one per node: a fleet screen asking per node
 * would be two queries times the fleet, which is the shape that is fine at
 * three nodes and is the reason the page is slow at three hundred.
 */
export async function balances(db: MasterDb): Promise<Array<NodeBalance>> {
  const rows = await db.select({ id: nodes.id, slug: nodes.slug }).from(nodes)
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)

  const used = new Map(
    (
      await db
        .select({ nodeId: nodeMeters.nodeId, total: sum(nodeMeters.credits) })
        .from(nodeMeters)
        .where(inArray(nodeMeters.nodeId, ids))
        .groupBy(nodeMeters.nodeId)
    ).map((row) => [row.nodeId, Number(row.total ?? 0)]),
  )

  const put = new Map(
    (
      await db
        .select({ nodeId: creditLedger.nodeId, total: sum(creditLedger.credits) })
        .from(creditLedger)
        .where(inArray(creditLedger.nodeId, ids))
        .groupBy(creditLedger.nodeId)
    ).map((row) => [row.nodeId, Number(row.total ?? 0)]),
  )

  return rows.map((row) => {
    const purchased = put.get(row.id) ?? 0
    const spent = used.get(row.id) ?? 0
    return {
      nodeId: row.id,
      slug: row.slug,
      purchased,
      used: spent,
      // Allowed below zero on purpose. Metering must not be the thing that
      // breaks somebody's shop, and what happens at the floor is a product
      // decision rather than a subtraction — see the roadmap's open question 7.
      balance: purchased - spent,
    }
  })
}

export interface PeriodBreakdown {
  period: string
  credits: number
  lines: Array<{
    item: string
    name: string
    unit: string
    quantity: number
    credits: number
    pending: boolean
  }>
}

/** What one node used, period by period, most recent first. */
export async function usageFor(
  db: MasterDb,
  nodeId: number,
): Promise<Array<PeriodBreakdown>> {
  const rows = await db
    .select()
    .from(nodeMeters)
    .where(eq(nodeMeters.nodeId, nodeId))
    .orderBy(sql`${nodeMeters.period} desc`)

  const byPeriod = new Map<string, PeriodBreakdown>()
  for (const row of rows) {
    const found = meterItem(row.item)
    const bucket = byPeriod.get(row.period) ?? {
      period: row.period,
      credits: 0,
      lines: [],
    }
    bucket.credits += row.credits
    bucket.lines.push({
      item: row.item,
      name: found?.name ?? row.item,
      unit: found?.unit ?? 'each',
      quantity: row.quantity,
      credits: row.credits,
      pending: row.pending,
    })
    byPeriod.set(row.period, bucket)
  }

  for (const bucket of byPeriod.values()) {
    // In price-list order, so the same shape of bill appears every month
    // regardless of which items happened to have usage on them.
    const order = PRICE_LIST.map((item) => item.key)
    bucket.lines.sort(
      (left, right) => order.indexOf(left.item) - order.indexOf(right.item),
    )
  }

  return [...byPeriod.values()]
}

/**
 * Puts credits in.
 *
 * `dedupeKey` is the guarantee, not a check beforehand — a payment webhook
 * delivered twice posts the same key and the second insert is refused by the
 * index. The same discipline as every other money path here, because this is
 * one.
 */
export async function grantCredits(
  db: MasterDb,
  input: {
    nodeId: number
    kind: string
    credits: number
    amount?: number
    currency?: string
    note?: string
    dedupeKey?: string
  },
): Promise<boolean> {
  try {
    await db.insert(creditLedger).values({
      nodeId: input.nodeId,
      kind: input.kind,
      credits: Math.trunc(input.credits),
      amount: Math.trunc(input.amount ?? 0),
      currency: input.currency ?? 'USD',
      note: input.note ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    return true
  } catch {
    return false
  }
}

export { getDb }
export type { MasterEnv }
