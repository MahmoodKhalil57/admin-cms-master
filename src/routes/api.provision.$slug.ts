import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import type { MasterEnv } from '#/server/env'
import { getEnv } from '#/server/env'
import { templateMaintainedBy } from '#/lib/template-catalog'
import type { NodeOwner } from '#/server/provision'
import { deprovisionNode, provisionNode } from '#/server/provision'

/**
 * Looks up the master account that will own a node.
 *
 * Falls back to the sole master user when a node has no explicit owner, which
 * is the single-operator case; with several accounts the node has to say which
 * one, rather than master guessing.
 */
async function resolveOwner(
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

  const users = await ctx.adapter.findMany<{
    id: string
    email: string
    name: string
  }>({ model: 'user', limit: 2 })

  if (users.length !== 1) return undefined
  return {
    masterUserId: users[0].id,
    email: users[0].email,
    name: users[0].name,
  }
}

/** Only a signed-in operator may create or destroy nodes. */
async function requireSession(env: MasterEnv, request: Request) {
  return getAuth(env).api.getSession({ headers: request.headers })
}

/**
 * Provisioning is slow — creating D1, R2 and KV and uploading a multi-megabyte
 * Worker takes tens of seconds. This runs it inline, which is fine for an
 * operator triggering one node at a time, and is the seam where a queue or
 * Workflow goes once nodes are created by signup traffic.
 */
export const Route = createFileRoute('/api/provision/$slug')(
  serverRoute({
    POST: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await requireSession(env, request))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const db = getDb(env)
      const slug = params.slug

      const [node] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.slug, slug))
        .limit(1)

      if (!node) {
        return Response.json(
          { error: `No node with slug "${slug}"` },
          { status: 404 },
        )
      }

      await db
        .update(nodes)
        .set({ status: 'provisioning' })
        .where(eq(nodes.id, node.id))

      // The node's operator is seeded from a master account, and the node
      // records which one — that link is what lets the two be related later.
      const owner = await resolveOwner(env, node.ownerUserId)

      // Re-provisioning keeps the combo the node was created from; a fresh
      // node takes whichever one it was created with.
      const result = await provisionNode(env, slug, {
        owner,
        template: node.templateKey,
      })

      await db
        .update(nodes)
        .set({
          status: result.ok ? 'active' : 'failed',
          templateVersion: result.templateVersion ?? node.templateVersion,
          templateKey: result.templateKey ?? node.templateKey,
          ownerUserId: owner?.masterUserId ?? node.ownerUserId,
        })
        .where(eq(nodes.id, node.id))

      return Response.json(result, { status: result.ok ? 200 : 500 })
    },

    DELETE: async ({ request, params }) => {
      const env = getEnv(request)
      if (!(await requireSession(env, request))) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      // A base node is the template, not a copy of it: tearing it down takes
      // the thing every future project is created from with it. Removing it
      // from the catalog is the deliberate way to do that.
      const maintains = templateMaintainedBy(params.slug)
      if (maintains) {
        return Response.json(
          {
            error: `This node maintains the "${maintains.name}" template. Remove it from the template catalog before tearing it down.`,
          },
          { status: 409 },
        )
      }

      const result = await deprovisionNode(env, params.slug)

      await getDb(env)
        .update(nodes)
        .set({ status: 'pending', templateVersion: null })
        .where(eq(nodes.slug, params.slug))

      return Response.json(result, { status: result.ok ? 200 : 500 })
    },
  }),
)
