import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
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

