import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import type { MasterEnv } from '#/server/env'
import { balances } from '#/server/metering'
import {
  packageByKey,
  packagesFor,
  stripeConfig,
  subscriptionFor,
} from '#/server/billing'
import { cancelSubscription, createCheckout } from '#/server/billing/stripe'

/**
 * Buying credits.
 *
 * `GET` lists what is on offer and where each node stands. `POST` opens a
 * Checkout Session and hands back its URL — the card is typed on Stripe's
 * domain, so no card number is ever in a request this Worker serves.
 *
 * **Nothing here grants credits.** The browser coming back from Stripe proves
 * nothing: somebody who closes the tab has still paid, and somebody who opens
 * the success URL directly has not. Credits are granted by the webhook, and
 * only by the webhook.
 */
export const Route = createFileRoute('/api/billing')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const denied = await gate(env, request)
      if (denied) return denied

      const db = getDb(env)
      const url = new URL(request.url)
      const nodeId = Number(url.searchParams.get('node') ?? 0)

      return Response.json({
        configured: Boolean(stripeConfig(env)),
        packages: await packagesFor(db),
        balances: await balances(db),
        subscription: nodeId ? await subscriptionFor(db, nodeId) : null,
      })
    },

    POST: async ({ request }) => {
      const env = getEnv(request)
      const denied = await gate(env, request)
      if (denied) return denied

      const config = stripeConfig(env)
      if (!config) {
        return Response.json(
          { error: 'The platform is not set up to take payments yet.' },
          { status: 503 },
        )
      }

      const db = getDb(env)
      const body = (await request.json().catch(() => ({}))) as {
        nodeId?: number
        packageKey?: string
        returnTo?: string
      }

      const [node] = await db
        .select()
        .from(nodes)
        .where(eq(nodes.id, Number(body.nodeId)))
        .limit(1)
      if (!node) return Response.json({ error: 'No such node.' }, { status: 404 })

      const chosen = await packageByKey(db, String(body.packageKey ?? ''))
      if (!chosen) {
        return Response.json({ error: 'That is not on sale.' }, { status: 404 })
      }

      // One subscription at a time. Two would deliver two lots of credits every
      // month and nobody would notice until the invoice.
      if (chosen.monthly && (await subscriptionFor(db, node.id))) {
        return Response.json(
          { error: 'This node is already on a monthly package. Cancel it first.' },
          { status: 409 },
        )
      }

      const existing = await subscriptionFor(db, node.id)
      const origin = body.returnTo || new URL(request.url).origin

      try {
        const session = await createCheckout(config, {
          packageKey: chosen.key,
          name: chosen.name,
          credits: chosen.credits,
          price: chosen.price,
          currency: chosen.currency,
          monthly: chosen.monthly,
          nodeId: node.id,
          nodeSlug: node.slug,
          customerRef: existing?.customerRef ?? null,
          successUrl: `${origin}/usage?bought=${chosen.key}`,
          cancelUrl: `${origin}/usage`,
        })
        return Response.json(session)
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : 'Checkout failed.',
          },
          { status: 502 },
        )
      }
    },

    /** Ends a monthly package at the end of what has been paid for. */
    DELETE: async ({ request }) => {
      const env = getEnv(request)
      const denied = await gate(env, request)
      if (denied) return denied

      const config = stripeConfig(env)
      const db = getDb(env)
      const nodeId = Number(new URL(request.url).searchParams.get('node') ?? 0)
      const current = nodeId ? await subscriptionFor(db, nodeId) : null
      if (!config || !current) {
        return Response.json({ error: 'Nothing to cancel.' }, { status: 404 })
      }

      try {
        await cancelSubscription(config, current.providerRef)
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Stripe refused.' },
          { status: 502 },
        )
      }

      // The row is not touched here. Stripe will say so in a webhook, and the
      // status this console shows should be the provider's word rather than
      // our optimistic guess about what it is about to be.
      return Response.json({ ok: true, endsAt: current.currentPeriodEnd })
    },
  }),
)

async function gate(env: MasterEnv, request: Request): Promise<Response | null> {
  const session = await getAuth(env).api.getSession({ headers: request.headers })
  return session ? null : Response.json({ error: 'Unauthorized' }, { status: 401 })
}
