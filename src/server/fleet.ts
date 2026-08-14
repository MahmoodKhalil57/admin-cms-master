import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import type { MasterEnv } from './env'
import { loadImageFromR2 } from './node-image'
import { provisionNode } from './provision'
import type { NodeOwner } from './provision'
import { getAuth } from '#/lib/auth'

/**
 * One version, everywhere below master.
 *
 * Every node runs the same build, and a project a node creates runs it too.
 * Master is the exception and always will be: it is the thing holding the
 * images, so it cannot be one of the things it rolls.
 *
 * Provisioning already takes whatever image is current, so a *new* node is
 * never behind. Drift comes from the ones that already exist — publishing a
 * build changes what the next node gets and nothing about the ones already
 * running. So the fleet needs an action that says "all of you, now", and it
 * needs to be able to say which of them are not.
 *
 * Deliberately not automatic on publish. Rolling every node the moment a build
 * lands means one bad build takes the whole fleet at once, with nothing left
 * running to notice on. One command, one decision, and the drift is visible
 * until somebody makes it.
 */

export interface FleetNode {
  id: number
  slug: string
  status: string
  version: string | null
  /** whether it is running something other than the current image */
  behind: boolean
}

export interface FleetState {
  current: string | null
  nodes: Array<FleetNode>
  behind: number
  /**
   * Scripts in the dispatch namespace with no node behind them.
   *
   * A fleet that can only see its own table cannot tell you about the thing it
   * has forgotten — and a forgotten script still answers requests, on whatever
   * build it was left on, forever. Worth naming even though nothing here can
   * roll one: master has no row to provision from, so the only actions are to
   * adopt it or remove it, and both are somebody's decision.
   */
  orphans: Array<string>
}

export async function fleetState(env: MasterEnv): Promise<FleetState> {
  const image = await loadImageFromR2(env.IMAGES).catch(() => null)
  const current = image?.version ?? null

  const rows = await getDb(env).select().from(nodes)
  const list = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    status: row.status,
    version: row.templateVersion,
    // A node that has never been provisioned is not behind; it is not yet
    // anywhere. Saying otherwise would put it in a count somebody acts on.
    behind:
      row.status === 'active' &&
      Boolean(current) &&
      row.templateVersion !== current,
  }))

  return {
    current,
    nodes: list,
    behind: list.filter((node) => node.behind).length,
    orphans: await orphanScripts(env, rows.map((row) => `n-${row.slug}`)),
  }
}

/** Named `n-<slug>` by provisioning, so anything else in there is not ours. */
async function orphanScripts(
  env: MasterEnv,
  known: Array<string>,
): Promise<Array<string>> {
  try {
    const { listDispatchScripts } = await import('./cloudflare')
    const { cfConfigFrom } = await import('./provision')
    const { DISPATCH_NAMESPACE } = await import('./node-plan')
    const scripts = await listDispatchScripts(
      cfConfigFrom(env),
      DISPATCH_NAMESPACE,
    )
    return scripts.filter((name) => !known.includes(name))
  } catch {
    // Cloudflare unreachable, or the token cannot list. Not knowing is not the
    // same as there being none, so this says nothing rather than "all clear".
    return []
  }
}

export interface RollOutcome {
  slug: string
  ok: boolean
  from: string | null
  to?: string
  detail?: string
}

/**
 * Rolls every node that is behind, one at a time.
 *
 * Sequential on purpose. Uploading a Worker is not a cheap call, and a fleet
 * rolled in parallel is a fleet that hits an API limit halfway and leaves half
 * of itself on the old build — which is the state this whole function exists to
 * prevent.
 *
 * Each node is independent and provisioning is idempotent, so an interrupted
 * roll is resumed by running it again: the ones already current are skipped,
 * and the rest carry on from where it stopped.
 *
 * Owners are not reseeded. A roll must not change anybody's password, so the
 * existing account is left exactly as it is — see `seedNodeOwner`, which
 * reports `password unchanged` and returns nothing when the owner is there.
 */
export async function rollFleet(
  env: MasterEnv,
  options: { only?: Array<string>; includeCurrent?: boolean } = {},
): Promise<{ current: string | null; rolled: Array<RollOutcome> }> {
  const state = await fleetState(env)
  if (!state.current) {
    return { current: null, rolled: [] }
  }

  const db = getDb(env)
  const ctx = await getAuth(env).$context
  const rolled: Array<RollOutcome> = []

  const wanted = state.nodes.filter((node) => {
    if (options.only?.length && !options.only.includes(node.slug)) return false
    if (node.status !== 'active') return false
    return options.includeCurrent ? true : node.behind
  })

  for (const node of wanted) {
    const [row] = await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1)
    if (!row) continue

    let owner: NodeOwner | undefined
    if (row.ownerUserId) {
      const user = await ctx.internalAdapter.findUserById(row.ownerUserId)
      if (user) {
        owner = { masterUserId: user.id, email: user.email, name: user.name }
      }
    }

    try {
      const result = await provisionNode(env, row.slug, {
        owner,
        template: row.templateKey,
      })
      await db
        .update(nodes)
        .set({
          status: result.ok ? 'active' : 'failed',
          templateVersion: result.templateVersion ?? row.templateVersion,
        })
        .where(eq(nodes.id, row.id))

      rolled.push({
        slug: row.slug,
        ok: result.ok,
        from: node.version,
        to: result.templateVersion,
        detail: result.ok ? undefined : result.error,
      })
    } catch (error) {
      rolled.push({
        slug: row.slug,
        ok: false,
        from: node.version,
        detail: error instanceof Error ? error.message : 'Rolling failed.',
      })
    }
  }

  return { current: state.current, rolled }
}
