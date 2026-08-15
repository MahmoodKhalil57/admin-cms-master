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

/**
 * What credits can be bought in.
 *
 * Rows rather than code, unlike the price list — what things *cost* the
 * platform to run is a property of the build, but what somebody is *sold* is a
 * commercial decision that changes without a deploy. A package withdrawn keeps
 * its subscriptions running: `active` decides whether it can be bought, never
 * whether it can be held.
 *
 * `monthly` is the whole difference between a top-up and a subscription. Both
 * put the same credits in the same ledger; one does it once and one does it
 * every month until somebody stops it.
 */
export const creditPackages = sqliteTable(
  'credit_packages',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    key: text().notNull().unique(),
    name: text().notNull(),
    description: text(),
    credits: integer().notNull(),
    /** smallest unit of `currency` */
    price: integer().notNull(),
    currency: text().notNull().default('USD'),
    /** whether buying it starts a subscription rather than a single payment */
    monthly: integer({ mode: 'boolean' }).notNull().default(false),
    /** whether it can still be bought */
    active: integer({ mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('credit_packages_active').on(table.active)],
)

/**
 * A node on a monthly package.
 *
 * The credits a subscription delivers are posted to `credit_ledger` like any
 * other purchase — one line per invoice, keyed by the invoice id. So a renewal
 * that Stripe delivers twice grants once, and a subscription that lapses simply
 * stops adding lines rather than needing anything taken away.
 *
 * Which means this table records the *relationship*, not the money. What was
 * actually delivered is in the ledger, and the two can be compared.
 */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    nodeId: integer('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    packageKey: text('package_key').notNull(),
    /** the provider's subscription id */
    providerRef: text('provider_ref').notNull().unique(),
    /** the provider's customer id, so a second purchase reuses it */
    customerRef: text('customer_ref'),
    /** `active`, `past_due`, `canceled` — the provider's word, not ours */
    status: text().notNull().default('active'),
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [index('subscriptions_node').on(table.nodeId)],
)

/**
 * Every webhook the provider has sent master, kept whether or not it mattered.
 *
 * The same table the node has, for the same reason and with the same unique
 * index: providers retry and deliver out of order, and reading "have I seen
 * this" before acting leaves a gap that a second delivery fits into exactly.
 */
export const billingEvents = sqliteTable(
  'billing_events',
  {
    id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
    providerEventId: text('provider_event_id').notNull(),
    type: text().notNull(),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    result: text(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(
      sql`(unixepoch())`,
    ),
  },
  (table) => [uniqueIndex('billing_events_unique').on(table.providerEventId)],
)
