import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * A node is one provisioned instance of admin-cms-node-template.
 *
 * `slug` is the safety-critical field: every Cloudflare resource a node owns is
 * named by deriving it from the slug (`n-<slug>`, `n-<slug>-media`,
 * `n-<slug>-session`), and teardown deletes only by derived name. The `n-`
 * prefix is what keeps provisioning away from unrelated resources on the
 * account, so slugs are immutable once set.
 */
export const nodes = sqliteTable('nodes', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  slug: text().notNull().unique(),
  name: text().notNull(),
  hostname: text(),
  /**
   * The master account that owns this node.
   *
   * Points at Better Auth's `user` table, which Better Auth creates and
   * migrates itself — so this is deliberately not a Drizzle foreign key, to
   * avoid two migration systems fighting over the same constraint. At provision
   * time this user's identity is seeded into the node, and the node records the
   * id back, so the two accounts can be related later.
   */
  ownerUserId: text('owner_user_id'),
  /** pending -> provisioning -> active; failed and suspended are terminal-ish */
  status: text().notNull().default('pending'),
  /** which build of the node template this node is running */
  templateVersion: text('template_version'),
  /**
   * Which template combo this node was created from — the key of an entry in
   * the template catalog. Recorded rather than derived, so a node keeps saying
   * where it came from even after the catalog moves on.
   */
  templateKey: text('template_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})


/**
 * What a node used in a period, as master was told it.
 *
 * **Unique on (node, period, item), and written by replacing rather than
 * adding.** That one decision is what makes the whole pipeline safe: a node's
 * counted usage is derived from its own event log, so re-reporting a period
 * produces the same numbers, and a retry that replaces is a no-op while a retry
 * that adds is a double bill. There is no delivery-tracking to get wrong
 * because there is nothing that must arrive exactly once.
 *
 * `priceListVersion` is stamped on every row. A repricing must not rewrite what
 * anybody already owes, and without this a past period becomes unreproducible —
 * which is discovered for the first time when somebody disputes an invoice.
 */
export const nodeMeters = sqliteTable(
  'node_meters',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    nodeId: integer('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** `YYYY-MM`, in UTC */
    period: text().notNull(),
    /** a key from the price list */
    item: text().notNull(),
    /** how many, in the item's own unit — bytes for storage, each for the rest */
    quantity: integer().notNull().default(0),
    /** what that came to, priced at `priceListVersion` */
    credits: integer().notNull().default(0),
    priceListVersion: integer('price_list_version').notNull().default(1),
    /** declared in the price list, not yet actually measured by anything */
    pending: integer({ mode: 'boolean' }).notNull().default(false),
    reportedAt: integer('reported_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [
    uniqueIndex('node_meters_unique').on(table.nodeId, table.period, table.item),
    index('node_meters_period').on(table.period),
  ],
)

/**
 * Credits bought, granted or taken away. Never usage.
 *
 * Usage deliberately does not appear here, and that is the point: a balance is
 * `what was put in` minus `what the meter says came out`, and the meter is a
 * table that can be recomputed. Posting usage as ledger lines would mean a
 * re-report either duplicating a line or needing one deleted, and both are ways
 * to get a balance wrong that this shape simply does not have.
 *
 * So this side is append-only and the other side is replaceable, which is the
 * right way round: money somebody paid is a historical fact, and a measurement
 * is a current best answer.
 */
export const creditLedger = sqliteTable(
  'credit_ledger',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    nodeId: integer('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** `purchase`, `grant`, `adjustment`, `refund` */
    kind: text().notNull(),
    /** signed; positive puts credits in */
    credits: integer().notNull(),
    /** what was paid for them, in the smallest unit, when anything was */
    amount: integer().notNull().default(0),
    currency: text().notNull().default('USD'),
    note: text(),
    /** what makes this line unrepeatable; a payment id, usually */
    dedupeKey: text('dedupe_key').unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('credit_ledger_node').on(table.nodeId)],
)
