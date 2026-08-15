import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { applyBillingEvent, stripeConfig } from '#/server/billing'
import { verifyEvent } from '#/server/billing/stripe'

/**
 * What Stripe says happened.
 *
 * The only thing on this Worker that grants credits. A browser returning from
 * checkout proves nothing — somebody who closed the tab has still paid, and
 * somebody who typed the success URL has not — so the return page reads a
 * balance and this decides it.
 *
 * The body is read as **text** and parsed afterwards. The signature is over the
 * exact bytes Stripe sent, and re-serialising JSON changes them.
 */
export const Route = createFileRoute('/api/webhooks/stripe')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const config = stripeConfig(env)
      if (!config) {
        return Response.json({ error: 'Not configured.' }, { status: 503 })
      }

      const body = await request.text()
      const event = await verifyEvent(
        config,
        body,
        request.headers.get('stripe-signature'),
      )
      if (!event) {
        // Deliberately terse. A rejected webhook should not describe what was
        // wrong with it to whoever sent it.
        return Response.json({ error: 'Bad signature.' }, { status: 400 })
      }

      const applied = await applyBillingEvent(getDb(env), event)

      // 200 for everything understood, including duplicates and events that
      // mean nothing here — a non-2xx makes Stripe retry, and retrying an
      // event we correctly ignored is a queue that never drains.
      return Response.json({ received: true, ...applied })
    },
  }),
)
