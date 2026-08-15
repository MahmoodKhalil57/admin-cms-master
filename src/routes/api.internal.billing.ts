import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { deriveNodeSecret } from '#/server/provision'
import { balances } from '#/server/metering'
import {
  nodeBySlug,
  packageByKey,
  packagesFor,
  stripeConfig,
  subscriptionFor,
} from '#/server/billing'
import { createCheckout } from '#/server/billing/stripe'

/**
 * A node asking about its own bill, on behalf of its operator.
 *
 * The operator of a node never signs in to master — they have an account on
 * their own node and that is the only console they know. So the node asks for
 * them, authenticated the same way the mail and usage routes are, and can only
 * ever ask about itself.
 *
 * `GET` reads the balance and what is on offer. `POST` opens a Checkout Session
 * and returns its URL, which the node hands to the browser. Master still owns
 * the money: the node never sees a card, a key or a webhook.
 */
export const Route = createFileRoute('/api/internal/billing')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const body = (await request.json().catch(() => ({}))) as {
        slug?: string
        /** omitted to just read; set to start a purchase */
        packageKey?: string
        returnTo?: string
      }

      if (!body.slug) {
        return Response.json({ error: 'Which node?' }, { status: 400 })
      }
      const expected = await deriveNodeSecret(env, body.slug, 'provision')
      if (request.headers.get('authorization') !== `Bearer ${expected}`) {
        return Response.json({ error: 'Not allowed.' }, { status: 403 })
      }

      const db = getDb(env)
      const node = await nodeBySlug(db, body.slug)
      if (!node) return Response.json({ error: 'No such node.' }, { status: 404 })

      const mine = (await balances(db)).find((row) => row.nodeId === node.id)
      const subscription = await subscriptionFor(db, node.id)

      if (!body.packageKey) {
        return Response.json({
          configured: Boolean(stripeConfig(env)),
          balance: mine ?? { purchased: 0, used: 0, balance: 0 },
          packages: await packagesFor(db),
          subscription: subscription
            ? {
                packageKey: subscription.packageKey,
                status: subscription.status,
                currentPeriodEnd: subscription.currentPeriodEnd,
              }
            : null,
        })
      }

      const config = stripeConfig(env)
      if (!config) {
        return Response.json(
          { error: 'The platform is not set up to take payments yet.' },
          { status: 503 },
        )
      }

      const chosen = await packageByKey(db, body.packageKey)
      if (!chosen) {
        return Response.json({ error: 'That is not on sale.' }, { status: 404 })
      }
      if (chosen.monthly && subscription) {
        return Response.json(
          { error: 'You are already on a monthly package. Cancel it first.' },
          { status: 409 },
        )
      }

      // Back to the node's own console, not master's — the operator has never
      // seen master and should not be sent there by a payment.
      const origin = (body.returnTo || '').replace(/\/+$/, '')
      if (!origin.startsWith('https://')) {
        return Response.json({ error: 'Where should they come back to?' }, { status: 422 })
      }

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
          customerRef: subscription?.customerRef ?? null,
          successUrl: `${origin}/admin/billing?bought=${chosen.key}`,
          cancelUrl: `${origin}/admin/billing`,
        })
        return Response.json(session)
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'Checkout failed.' },
          { status: 502 },
        )
      }
    },
  }),
)
