import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { deriveNodeSecret } from '#/server/provision'
import { getDb } from '#/db'
import { storeUsage } from '#/server/metering'
import type { ReportedLine } from '#/server/metering'

/**
 * A node reporting what it used.
 *
 * Authenticated exactly as the mail route is — the derived provisioning secret,
 * which a node already holds and which is per-slug, so a node can only ever
 * report as itself. Nothing extra is stored to make this work.
 *
 * **No idempotency key, and that is not an oversight.** Counted usage is
 * derived from the node's own event log, so the same period recomputes to the
 * same numbers; master stores it by replacing rather than adding. A duplicate
 * delivery is therefore a no-op by construction, which is a stronger guarantee
 * than a key that has to be remembered, matched and eventually expired.
 */
export const Route = createFileRoute('/api/internal/usage')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const body = (await request.json().catch(() => ({}))) as {
        slug?: string
        period?: string
        priceListVersion?: number
        lines?: Array<ReportedLine>
      }

      if (!body.slug) {
        return Response.json({ error: 'Which node?' }, { status: 400 })
      }
      const expected = await deriveNodeSecret(env, body.slug, 'provision')
      if (request.headers.get('authorization') !== `Bearer ${expected}`) {
        return Response.json({ error: 'Not allowed.' }, { status: 403 })
      }

      // `YYYY-MM` and nothing else. A period is a key that rows are replaced
      // by, so a malformed one would quietly open a second bucket for the same
      // month and both would look right on their own.
      if (!body.period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period)) {
        return Response.json(
          { error: 'A period is YYYY-MM.' },
          { status: 422 },
        )
      }

      const stored = await storeUsage(getDb(env), body.slug, {
        period: body.period,
        priceListVersion: Number(body.priceListVersion ?? 1),
        lines: Array.isArray(body.lines) ? body.lines : [],
      })

      if (!stored) {
        return Response.json({ error: 'No such node.' }, { status: 404 })
      }

      return Response.json({ ok: true, ...stored })
    },
  }),
)
