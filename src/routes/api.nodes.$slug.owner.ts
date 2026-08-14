import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import type { MasterEnv } from '#/server/env'
import { resetNodeOwner } from '#/server/provision'
import type { NodeOwner } from '#/server/provision'

/**
 * Giving a node's root admin a new password.
 *
 * Provisioning creates that account and shows its password once. If nobody
 * wrote it down there was, until now, no way back in short of rebuilding the
 * node — which is a poor answer, because the account is the only guaranteed way
 * into a node and losing it is the most ordinary mistake there is.
 *
 * Its own route rather than a flag on provisioning, because it is a different
 * act: this ends every session that account has open. Something somebody
 * chooses, not a side effect of a redeploy.
 */

async function ownerFor(
  env: MasterEnv,
  ownerUserId: string | null,
): Promise<NodeOwner | undefined> {
  const ctx = await getAuth(env).$context

  if (ownerUserId) {
    const user = await ctx.internalAdapter.findUserById(ownerUserId)
    return user
      ? { masterUserId: user.id, email: user.email, name: user.name }
      : undefined
  }

  // The single-operator case, matching how provisioning resolves it.
  const users = await ctx.adapter.findMany<{
    id: string
    email: string
    name: string
  }>({ model: 'user', limit: 2 })
  if (users.length !== 1) return undefined
  return {
    masterUserId: users[0]!.id,
    email: users[0]!.email,
    name: users[0]!.name,
  }
}

export const Route = createFileRoute('/api/nodes/$slug/owner')(
  serverRoute({
    POST: async ({ request, params }) => {
      const env = getEnv(request)
      const session = await getAuth(env).api.getSession({
        headers: request.headers,
      })
      if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const [node] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.slug, params.slug))
        .limit(1)
      if (!node) {
        return Response.json({ error: 'No such node.' }, { status: 404 })
      }

      const owner = await ownerFor(env, node.ownerUserId)
      if (!owner) {
        return Response.json(
          {
            error:
              'This node has no owner recorded, and there is more than one account here to guess from.',
          },
          { status: 409 },
        )
      }

      const result = await resetNodeOwner(env, params.slug, owner)
      if (!result.ok) {
        return Response.json({ error: result.detail }, { status: 502 })
      }

      // The only time it exists outside the node. Not stored here, and not
      // recoverable — the next one is another reset.
      return Response.json(
        {
          ok: true,
          email: owner.email,
          password: result.password,
          detail: result.detail,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    },
  }),
)
